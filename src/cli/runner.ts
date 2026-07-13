import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import prompts from 'prompts';
import { DevMindDatabase } from '../db/database';
import { readScratchpad, createScratchpad, writeScratchpad } from '../db/indexer';
import { scanRepoFiles } from '../utils/scanner';
import { loadProjectContext } from '../utils/config';
import { safeJsonParse } from '../utils/json';
import { resolveConnectionsLocally } from '../utils/ast';

interface ExtractedNode {
  node_id: string;
  name: string;
  type: string;
  signature?: string;
  code_snapshot?: string;
}

interface ExtractionResult {
  nodes?: ExtractedNode[];
}

function makeHttpRequest(
  urlStr: string,
  method: string,
  headers: Record<string, string>,
  body: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const isHttps = urlStr.startsWith('https');
    const lib = isHttps ? https : http;
    
    try {
      const url = new URL(urlStr);
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers
        },
        (res) => {
          let chunks = '';
          res.on('data', (chunk) => {
            chunks += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(chunks);
            } else {
              reject(new Error(`Request failed with status ${res.statusCode}: ${chunks}`));
            }
          });
        }
      );
      
      req.on('error', (err) => {
        reject(err);
      });
      
      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Progress Display ─────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BAR_WIDTH = 28;
const IS_TTY = !!process.stdout.isTTY;

function fmtMs(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs.toString().padStart(2, '0')}s`;
}

function makeBar(done: number, total: number): string {
  const pct = total > 0 ? done / total : 0;
  const filled = Math.round(BAR_WIDTH * pct);
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}]`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? '…' + s.slice(-(max - 1)) : s;
}

const MAX_LOG_LINES = 18;

class ProgressDisplay {
  private isTTY = IS_TTY;
  private spinIdx = 0;

  // phase state
  private phaseNum = 0;
  private totalPhases = 2;
  private total = 0;
  private done = 0;
  private phaseStart = 0;
  private itemStart = 0;
  private times: number[] = [];
  private currentItem = '';
  private statusLine = '';

  // scrolling log ring buffer
  private logLines: string[] = [];
  // total lines currently drawn on screen (log + bar)
  private drawnLines = 0;

  startPhase(phaseNum: number, label: string, total: number, alreadyDone = 0) {
    this.phaseNum = phaseNum;
    this.total = total;
    this.done = alreadyDone;
    this.times = [];
    this.phaseStart = Date.now();
    this.currentItem = alreadyDone > 0 ? `Resuming from item ${alreadyDone + 1}…` : 'Starting…';
    this.statusLine = '';
    this.logLines = [];
    this.drawnLines = 0;

    if (!this.isTTY) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(` Phase ${phaseNum}/${this.totalPhases}: ${label}`);
      console.log(`${'═'.repeat(60)}`);
      if (alreadyDone > 0) console.log(` Resuming: ${alreadyDone}/${total} already done`);
      console.log(` Remaining: ${total - alreadyDone} item(s) to process`);
      console.log(`${'─'.repeat(60)}\n`);
    } else {
      const resumeTag = alreadyDone > 0 ? ` \x1B[90m(resuming from ${alreadyDone}/${total})\x1B[0m` : '';
      process.stdout.write(`\n  \x1B[1m\x1B[36mPhase ${phaseNum}/${this.totalPhases}: ${label}\x1B[0m${resumeTag}\n`);
      this._render();
    }
  }

  beginItem(name: string) {
    this.currentItem = name;
    this.itemStart = Date.now();
    this.statusLine = '';
    this.spinIdx = (this.spinIdx + 1) % SPINNER_FRAMES.length;
    if (this.isTTY) this._render();
    else process.stdout.write(`  [${this.done + 1}/${this.total}] ${name} … `);
  }

  completeItem(extra = '') {
    const t = Date.now() - this.itemStart;
    this.times.push(t);
    this.done++;
    this.statusLine = extra;
    if (this.isTTY) this._render();
    else console.log(`done (${fmtMs(t)})  ${extra}`);
  }

  skipItem(reason: string) {
    this.done++;
    this.statusLine = `skip — ${reason}`;
    if (this.isTTY) this._render();
    else console.log(`  skip — ${reason}`);
  }

  updateStatus(msg: string) {
    this.statusLine = msg;
    if (this.isTTY) this._render();
    else console.log(`  ... ${msg}`);
  }

  /** Push a log line into the scrolling log panel and re-render */
  log(msg: string) {
    const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.logLines.push(`  \x1B[90m${ts}\x1B[0m  ${msg}`);
    if (this.logLines.length > MAX_LOG_LINES) {
      this.logLines.shift();
    }
    if (this.isTTY) {
      this._render();
    } else {
      console.log(`  ${msg}`);
    }
  }

  private _render() {
    // Clear all previously drawn lines
    if (this.drawnLines > 0) {
      process.stdout.write(`\x1B[${this.drawnLines}A\x1B[0J`);
    }

    const pct = this.total > 0 ? (this.done / this.total) * 100 : 0;
    const bar = makeBar(this.done, this.total);
    const elapsed = Date.now() - this.phaseStart;
    const avg = this.times.length > 0
      ? this.times.reduce((a, b) => a + b, 0) / this.times.length
      : 0;
    const remaining = this.total - this.done;
    const eta = avg > 0 && remaining > 0 ? avg * remaining : 0;
    const spin = SPINNER_FRAMES[this.spinIdx];
    const itemShort = truncate(this.currentItem, 64);
    const pctStr = `${Math.round(pct)}%`.padStart(4);
    const doneStr = `${this.done}/${this.total}`;

    // ── Log panel (scrolling lines) ──────────────────────────────────
    const logSection: string[] = this.logLines.length > 0
      ? [
          `  \x1B[90m${'─'.repeat(60)}\x1B[0m`,
          ...this.logLines,
          `  \x1B[90m${'─'.repeat(60)}\x1B[0m`,
        ]
      : [];

    // ── Progress bar (fixed) ─────────────────────────────────────────
    const barSection: string[] = [
      `  ${spin} ${bar}  ${doneStr.padEnd(11)} ${pctStr}`,
      `  ⏱  Elapsed : \x1B[33m${fmtMs(elapsed)}\x1B[0m   ETA : \x1B[32m${eta > 0 ? '~' + fmtMs(eta) : remaining > 0 ? 'calculating…' : 'done!'}\x1B[0m`,
      `  ⚡  Avg/item: \x1B[35m${avg > 0 ? fmtMs(avg) : '—'}\x1B[0m${ this.statusLine ? `   \x1B[33m${truncate(this.statusLine, 40)}\x1B[0m` : '' }`,
      `  ▶  \x1B[96m${itemShort}\x1B[0m`,
      ``,
    ];

    const all = [...logSection, ...barSection];
    process.stdout.write(all.join('\n'));
    this.drawnLines = all.length;
  }

  finishPhase(summary: string) {
    if (this.isTTY && this.drawnLines > 0) {
      process.stdout.write(`\x1B[${this.drawnLines}A\x1B[0J`);
      this.drawnLines = 0;
    }
    const elapsed = Date.now() - this.phaseStart;
    const avg = this.times.length > 0
      ? this.times.reduce((a, b) => a + b, 0) / this.times.length
      : 0;
    const checkmark = '\x1B[32m✔\x1B[0m';
    console.log(`  ${checkmark} ${summary}  \x1B[90m(total: ${fmtMs(elapsed)}, avg: ${avg > 0 ? fmtMs(avg) : '—'}/item)\x1B[0m`);
  }
}


// Build standard taxonomy prompt text
const TAXONOMY_PROMPT = `
Choose node types from this taxonomy:
- UNIVERSAL: function | method | class | abstract_class | interface | type_alias | enum | constant | variable | module | namespace | decorator
- NESTJS: nest_module | nest_controller | nest_service | nest_provider | nest_guard | nest_interceptor | nest_pipe | nest_filter | nest_decorator | nest_middleware | nest_gateway | nest_resolver | nest_schema | nest_dto
- EXPRESS/FASTIFY: route_handler | middleware | router
- SPRING (Java): spring_controller | spring_service | spring_repository | spring_component | spring_bean | spring_config | spring_entity
- DJANGO/FASTAPI: django_view | django_model | django_serializer | django_form | django_signal | fastapi_router | fastapi_dependency
- GO: go_handler | go_middleware | go_struct | go_interface | go_func
- RUST: rust_struct | rust_impl | rust_trait | rust_enum | rust_fn | rust_macro
- REACT/NEXTJS: react_component | react_hook | react_context | react_hoc | react_page | next_page | next_layout | next_api_route | next_server_action
- ORM: prisma_model | typeorm_entity | mongoose_model | sqlalchemy_model
- REST/API/GRAPHQL: api_endpoint | rest_controller | graphql_resolver | graphql_query | graphql_mutation | graphql_schema
- CLI: cli_command | cli_option
- UTILITY: util_function | helper | validator | formatter
`;

// ── Vertex AI Authentication & Helper Functions ───────────────────────────

function base64UrlEncode(obj: any): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function getAccessTokenFromServiceAccount(sa: { client_email: string; private_key: string; token_uri?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const header = { alg: 'RS256', typ: 'JWT' };
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
      };

      const dataToSign = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(dataToSign);
      const signature = signer.sign(sa.private_key, 'base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const jwt = `${dataToSign}.${signature}`;
      const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
      const body = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`;
      
      const url = new URL(tokenUri);
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
          }
        },
        (res) => {
          let chunks = '';
          res.on('data', (chunk) => {
            chunks += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(chunks);
                if (parsed.access_token) {
                  resolve(parsed.access_token);
                } else {
                  reject(new Error(`No access token in response: ${chunks}`));
                }
              } catch (e) {
                reject(e);
              }
            } else {
              reject(new Error(`Token request failed with status ${res.statusCode}: ${chunks}`));
            }
          });
        }
      );
      
      req.on('error', (err) => {
        reject(err);
      });
      
      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

let cachedVertexToken: string | null = null;
let vertexTokenExpiry = 0; // Epoch ms

async function getVertexTokenCached(saData: any): Promise<string> {
  const now = Date.now();
  if (cachedVertexToken && vertexTokenExpiry > now + 300000) {
    return cachedVertexToken;
  }
  const token = await getAccessTokenFromServiceAccount(saData);
  cachedVertexToken = token;
  vertexTokenExpiry = Date.now() + 3600 * 1000;
  return token;
}

async function extractWithVertex(
  model: string,
  token: string,
  projectId: string,
  location: string,
  filePath: string,
  code: string
): Promise<ExtractionResult> {
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
  
  const systemPrompt = `You are a codebase indexing assistant. Your job is to analyze the source code file provided and extract all code structures (functions, methods, classes, controllers, services, interfaces, schema models, types) defined in the file.
Return ONLY a valid JSON object matching the schema:
{
  "nodes": [
    { 
      "node_id": "fully_qualified_identifier (e.g. Class.method or function)", 
      "name": "display_name", 
      "type": "type_from_taxonomy", 
      "signature": "param/return signature (optional)",
      "code_snapshot": "the exact full source code block of this entity"
    }
  ]
}
${TAXONOMY_PROMPT}
CRITICAL RULES:
1. ONLY extract code structures defined in the file. Do NOT extract imports or third-party libraries as nodes.
2. For each node, extract its exact code snippet as "code_snapshot".
3. DO NOT wrap JSON in markdown blocks (e.g. no \`\`\`json). Return raw JSON.
4. Be highly precise and return an empty JSON object if no code constructs are found.`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `File path: ${filePath}\n\nCode:\n${code}`
          }
        ]
      }
    ],
    systemInstruction: {
      parts: [
        {
          text: systemPrompt
        }
      ]
    },
    generationConfig: {
      responseMimeType: 'application/json'
    }
  };

  const responseText = await makeHttpRequest(
    url,
    'POST',
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    JSON.stringify(payload)
  );

  const parsed = safeJsonParse(responseText, {} as any);
  const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    return {};
  }
  return safeJsonParse<ExtractionResult>(text, {});
}

async function extractWithGemini(
  model: string,
  key: string,
  filePath: string,
  code: string
): Promise<ExtractionResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  
  const systemPrompt = `You are a codebase indexing assistant. Your job is to analyze the source code file provided and extract all code structures (functions, methods, classes, controllers, services, interfaces, schema models, types) defined in the file.
Return ONLY a valid JSON object matching the schema:
{
  "nodes": [
    { 
      "node_id": "fully_qualified_identifier (e.g. Class.method or function)", 
      "name": "display_name", 
      "type": "type_from_taxonomy", 
      "signature": "param/return signature (optional)",
      "code_snapshot": "the exact full source code block of this entity"
    }
  ]
}
${TAXONOMY_PROMPT}
CRITICAL RULES:
1. ONLY extract code structures defined in the file. Do NOT extract imports or third-party libraries as nodes.
2. For each node, extract its exact code snippet as "code_snapshot".
3. DO NOT wrap JSON in markdown blocks (e.g. no \`\`\`json). Return raw JSON.
4. Be highly precise and return an empty JSON object if no code constructs are found.`;

  const payload = {
    contents: [
      {
        parts: [
          {
            text: `File path: ${filePath}\n\nCode:\n${code}`
          }
        ]
      }
    ],
    systemInstruction: {
      parts: [
        {
          text: systemPrompt
        }
      ]
    },
    generationConfig: {
      responseMimeType: 'application/json'
    }
  };

  const responseText = await makeHttpRequest(
    url,
    'POST',
    { 'Content-Type': 'application/json' },
    JSON.stringify(payload)
  );

  const parsed = safeJsonParse(responseText, {} as any);
  const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    return {};
  }
  return safeJsonParse<ExtractionResult>(text, {});
}

async function extractWithOllama(
  url: string,
  model: string,
  filePath: string,
  code: string
): Promise<ExtractionResult> {
  const endpoint = `${url.replace(/\/$/, '')}/api/chat`;
  
  const systemPrompt = `You are a codebase indexing assistant. Analyze this source code file and extract code structures (functions, classes, methods, endpoints).
Return ONLY a valid JSON object matching the schema:
{
  "nodes": [
    { 
      "node_id": "unique_string (e.g. Class.method or function)", 
      "name": "display_name", 
      "type": "type_from_taxonomy", 
      "signature": "param/return signature (optional)",
      "code_snapshot": "the exact full source code block of this entity"
    }
  ]
}
${TAXONOMY_PROMPT}
CRITICAL RULES:
1. ONLY extract constructs defined in this file. Do NOT extract third-party libraries or imports.
2. For each node, extract its exact code snippet as "code_snapshot".
3. Return a clean, valid JSON object.`;

  const userPrompt = `File path: ${filePath}\n\nCode:\n${code}`;

  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: false,
    format: 'json'
  };

  const responseText = await makeHttpRequest(
    endpoint,
    'POST',
    { 'Content-Type': 'application/json' },
    JSON.stringify(payload)
  );

  const parsed = safeJsonParse(responseText, {} as any);
  const text = parsed.message?.content;
  if (!text) {
    return {};
  }
  return safeJsonParse<ExtractionResult>(text, {});
}

async function extractNodesFromCode(
  provider: 'gemini' | 'vertex' | 'ollama',
  modelName: string,
  key: string | undefined,
  url: string | undefined,
  filePath: string,
  code: string,
  getVertexToken: () => Promise<string>,
  vertexProjectId: string,
  vertexLocation: string,
  progress: ProgressDisplay,
  chunkSize?: number,
  chunkOverlap?: number
): Promise<ExtractionResult> {
  // Chunking is opt-in: with no --chunk-size, the whole file always goes in one call.
  const maxLines = chunkSize;
  const overlap = chunkOverlap ?? 50;
  const lines = code.split('\n');

  const executeExtraction = async (codeChunk: string): Promise<ExtractionResult> => {
    let retries = 5;
    let backoffMs = 10000;
    while (retries > 0) {
      try {
        if (provider === 'gemini') {
          return await extractWithGemini(modelName, key!, filePath, codeChunk);
        } else if (provider === 'vertex') {
          const token = await getVertexToken();
          return await extractWithVertex(modelName, token, vertexProjectId, vertexLocation, filePath, codeChunk);
        } else {
          return await extractWithOllama(url!, modelName, filePath, codeChunk);
        }
      } catch (err) {
        retries--;
        if (retries === 0) {
          throw err;
        }
        const errMsg = (err as Error).message;
        if (errMsg.includes('429')) {
          progress.updateStatus(`Rate limited (429). Retrying in ${backoffMs / 1000}s...`);
          await sleep(backoffMs);
          backoffMs *= 2;
        } else {
          progress.updateStatus(`API error. Retrying in 2s...`);
          await sleep(2000);
        }
      }
    }
    return {};
  };

  if (!maxLines || lines.length <= maxLines) {
    return await executeExtraction(code);
  }

  const relPath = path.relative(process.cwd(), filePath);
  progress.log(`\x1B[90m[${relPath}] Large file (${lines.length} lines) - parsing in chunks to prevent LLM output truncation...\x1B[0m`);
  const chunks: string[] = [];
  let start = 0;
  // Guard against overlap >= chunkSize, which would make the step <= 0 and loop forever.
  const step = Math.max(1, maxLines - overlap);
  while (start < lines.length) {
    const end = Math.min(start + maxLines, lines.length);
    chunks.push(lines.slice(start, end).join('\n'));
    if (end === lines.length) break;
    start += step;
  }

  const seenNodeIds = new Map<string, ExtractedNode>();

  for (let i = 0; i < chunks.length; i++) {
    progress.updateStatus(`Sending chunk ${i + 1}/${chunks.length} to AI…`);
    const chunkCode = chunks[i];
    try {
      const chunkResult = await executeExtraction(chunkCode);
      if (chunkResult.nodes && Array.isArray(chunkResult.nodes)) {
        for (const node of chunkResult.nodes) {
          if (!node.node_id) continue;
          const existing = seenNodeIds.get(node.node_id);
          if (!existing || (node.code_snapshot && (!existing.code_snapshot || node.code_snapshot.length > existing.code_snapshot.length))) {
            seenNodeIds.set(node.node_id, node);
          }
        }
      }
    } catch (err) {
      progress.log(`\x1B[31mError extracting chunk ${i + 1}/${chunks.length}: ${(err as Error).message}\x1B[0m`);
      throw err;
    }

    if (i < chunks.length - 1) {
      if (provider === 'gemini' || provider === 'vertex') {
        await sleep(1500);
      } else {
        await sleep(100);
      }
    }
  }

  return { nodes: Array.from(seenNodeIds.values()) };
}

export async function runBackgroundIndexing(opts: {
  devmindPath: string;
  provider: 'gemini' | 'vertex' | 'ollama';
  model?: string;
  key?: string;
  url?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  /** @deprecated Connections are always resolved locally via AST now. Accepted as a no-op for backward compatibility. */
  localEdges?: boolean;
  fromScratch?: boolean;
  nodesOnly?: boolean;
  edgesOnly?: boolean;
  repos?: string[];
  yes?: boolean;
}) {
  const resolvedDevmind = path.resolve(opts.devmindPath);
  const chunkSize = opts.chunkSize;
  const chunkOverlap = opts.chunkOverlap;
  const fromScratch = !!opts.fromScratch;
  const nodesOnly = !!opts.nodesOnly;
  const edgesOnly = !!opts.edgesOnly;

  // Repo scoping: restrict the whole operation to the named repos. Standalone-only.
  const scopedRepos: string[] | null = opts.repos && opts.repos.length ? opts.repos : null;
  const inScope = (nodeId: string): boolean =>
    !scopedRepos || scopedRepos.some(r => nodeId.startsWith(`{${r}}/`));
  if (scopedRepos) {
    let ctx: ReturnType<typeof loadProjectContext>;
    try {
      ctx = loadProjectContext(resolvedDevmind);
    } catch (err) {
      console.error(`❌ Error: ${(err as Error).message}`);
      process.exit(1);
    }
    if (ctx.config.mode !== 'standalone') {
      console.error('❌ Error: --repos only works in standalone mode (embedded projects share one root, so per-repo scoping does not apply).');
      process.exit(1);
    }
    if (fromScratch) {
      console.error('❌ Error: --from-scratch wipes the entire graph, so it cannot be combined with --repos. Drop one of them.');
      process.exit(1);
    }
    const known = new Set(ctx.config.repos.map(r => r.name));
    const unknown = scopedRepos.filter(r => !known.has(r));
    if (unknown.length) {
      console.error(`❌ Error: unknown repo name(s): ${unknown.join(', ')}`);
      console.error(`   Valid repos: ${[...known].join(', ')}`);
      process.exit(1);
    }
    console.log(`   Scope           : repos = ${scopedRepos.join(', ')}`);
  }
  // Scoped runs use a SEPARATE scratchpad so they can't clobber (or mark "complete") the
  // global session — otherwise a later full `index --run` would see the scoped run's
  // "complete" and skip every un-indexed repo.
  const padFile: string | undefined = scopedRepos ? 'index_scratchpad.scoped.json' : undefined;

  console.log(`\n🧠 DevsMind Background Indexer`);
  console.log(`   Brain directory : ${resolvedDevmind}`);
  console.log(`   Provider        : ${opts.provider}`);
  console.log(`   Connections     : local AST resolution (always)`);
  console.log(`   Chunking        : ${chunkSize ? `${chunkSize} lines (overlap: ${chunkOverlap ?? 50})` : 'off — whole file per call'}`);

  let modelName = opts.model || '';
  let vertexSaData: any = null;
  let vertexToken: string | null = null;
  let vertexProjectId = '';
  let vertexLocation = 'us-central1';

  // --edges-only never calls the LLM (Phase 1 is skipped entirely), so it shouldn't
  // require provider credentials at all.
  if (!edgesOnly) {
    if (opts.provider === 'gemini') {
      modelName = modelName || 'gemini-2.0-flash';
      const apiKey = opts.key || process.env.GEMINI_API_KEY || '';
      if (!apiKey) {
        console.error('❌ Error: Gemini API key is required. Pass --key or set GEMINI_API_KEY environment variable.');
        process.exit(1);
      }
      opts.key = apiKey;
    } else if (opts.provider === 'vertex') {
      modelName = modelName || 'gemini-1.5-flash';
      const inputKey = opts.key || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.VERTEX_API_KEY || process.env.GEMINI_API_KEY || '';
      if (!inputKey) {
        console.error('❌ Error: Vertex AI requires a Service Account JSON path or Bearer Token. Pass --key or set GOOGLE_APPLICATION_CREDENTIALS / VERTEX_API_KEY environment variable.');
        process.exit(1);
      }

      try {
        if (inputKey.trim().startsWith('{')) {
          vertexSaData = JSON.parse(inputKey);
        } else if (fs.existsSync(inputKey)) {
          vertexSaData = JSON.parse(fs.readFileSync(inputKey, 'utf-8'));
        }
      } catch (e) {
        // Treat as raw token
      }

      vertexProjectId = vertexSaData?.project_id || process.env.GCP_PROJECT_ID || process.env.VERTEX_PROJECT_ID || '';
      vertexLocation = process.env.GCP_LOCATION || process.env.VERTEX_LOCATION || 'us-central1';

      if (!vertexSaData && !inputKey.startsWith('ya29.')) {
        console.error('❌ Error: Vertex key must be a valid Service Account JSON file path, inline JSON, or raw OAuth access token starting with "ya29."');
        process.exit(1);
      }

      if (!vertexProjectId) {
        console.error('❌ Error: Vertex Project ID could not be determined. Please set GCP_PROJECT_ID environment variable or specify it in your service account JSON.');
        process.exit(1);
      }

      if (!vertexSaData) {
        vertexToken = inputKey; // Raw Bearer token
      }
    } else {
      modelName = modelName || 'qwen2.5-coder';
      opts.url = opts.url || 'http://localhost:11434';
    }

    console.log(`   Model           : ${modelName}`);
  }

  const getVertexToken = async (): Promise<string> => {
    if (vertexToken) return vertexToken;
    if (vertexSaData) {
      return await getVertexTokenCached(vertexSaData);
    }
    throw new Error('No Vertex credentials available');
  };

  // 1. Open DB
  const dbFile = path.join(resolvedDevmind, 'brain.db');
  const db = new DevMindDatabase(dbFile);

  // --from-scratch: wipe everything (with confirmation) before proceeding.
  if (fromScratch) {
    if (!opts.yes) {
      const confirmResult = await prompts({
        type: 'confirm',
        name: 'yes',
        message: '🚨 WARNING: --from-scratch will permanently delete ALL nodes, connections, history, and the committed graph/ and history/ folders, then reindex from zero. Are you absolutely sure?',
        initial: false
      });
      if (!confirmResult.yes) {
        console.log('Aborted — nothing was changed.');
        db.close();
        return;
      }
    }
    console.log('💥 Wiping all nodes, connections, history, and graph/history folders...');
    db.resetAll();
    const scratchpadFile = path.join(resolvedDevmind, 'index_scratchpad.json');
    if (fs.existsSync(scratchpadFile)) {
      fs.unlinkSync(scratchpadFile);
    }
  }

  // --edges-only: skip Phase 1 entirely, wipe existing edges, rebuild them fresh
  // across every currently-active node using the AST resolver. Requires nodes to
  // already exist (from a prior full index or a --nodes-only run).
  if (edgesOnly) {
    // All nodes stay in the candidate pool (targets can live in any repo/file), but when
    // scoped we only rebuild edges ORIGINATING from the named repos' nodes.
    const allNodes = db.listNodes();
    if (allNodes.length === 0) {
      console.error('❌ Error: --edges-only requires nodes to already exist. Run without --edges-only first (or with --nodes-only) to extract nodes.');
      db.close();
      process.exit(1);
    }
    const existingNodes = scopedRepos ? allNodes.filter(n => inScope(n.id)) : allNodes;
    if (existingNodes.length === 0) {
      console.error(`❌ Error: no nodes found for repo(s): ${scopedRepos?.join(', ')}. Extract nodes first.`);
      db.close();
      process.exit(1);
    }

    let edgePad = readScratchpad(resolvedDevmind, padFile);
    let resumeIndex = 0;
    // Scoped runs never resume the shared scratchpad (its counts describe a different set).
    if (!scopedRepos && edgePad && edgePad.phase === 2 && edgePad.status === 'in_progress' && edgePad.nodes_total === existingNodes.length) {
      resumeIndex = edgePad.nodes_done || 0;
      console.log(`↻ Resuming edge rebuild from node ${resumeIndex + 1}/${existingNodes.length}`);
    } else {
      if (scopedRepos) {
        console.log(`🧹 Clearing connections for ${existingNodes.length} node(s) in scope...`);
        db.clearConnectionsForSources(existingNodes.map(n => n.id));
      } else {
        console.log('🧹 Clearing existing connections...');
        db.clearAllConnections();
      }
      edgePad = createScratchpad(resolvedDevmind, 0, padFile);
      edgePad.phase = 2;
      edgePad.nodes_total = existingNodes.length;
      writeScratchpad(resolvedDevmind, edgePad, padFile);
    }

    const edgeProgress = new ProgressDisplay();
    const allNodeIds = allNodes.map(n => n.id);
    edgeProgress.startPhase(2, 'AI Connection Resolution', existingNodes.length, resumeIndex);

    for (let i = resumeIndex; i < existingNodes.length; i++) {
      const node = existingNodes[i];
      edgeProgress.beginItem(node.id);

      const latestCode = db.getLatestCode(node.id);
      if (!latestCode || !latestCode.code_snapshot || latestCode.code_snapshot.trim().length === 0) {
        edgePad.nodes_done = i + 1;
        writeScratchpad(resolvedDevmind, edgePad, padFile);
        edgeProgress.skipItem('no code snapshot');
        continue;
      }

      edgeProgress.updateStatus(`Resolving connections locally via AST…`);
      const connections = resolveConnectionsLocally(node.id, node.file_path, allNodes, resolvedDevmind);

      let addedCount = 0;
      for (const targetId of connections) {
        if (allNodeIds.includes(targetId)) {
          edgeProgress.log(`Linked: \x1B[36m${node.id}\x1B[0m → \x1B[36m${targetId}\x1B[0m`);
          db.addConnection(node.id, targetId);
          addedCount++;
        }
      }

      edgePad.nodes_done = i + 1;
      edgePad.connections_created += addedCount;
      writeScratchpad(resolvedDevmind, edgePad, padFile);
      edgeProgress.completeItem(`${edgePad.connections_created} connection(s) created so far`);
    }

    edgeProgress.finishPhase(`Phase 2 done — ${edgePad.connections_created} connection(s) linked across ${existingNodes.length} node(s)`);

    edgePad.status = 'complete';
    edgePad.updated_at = new Date().toISOString();
    writeScratchpad(resolvedDevmind, edgePad, padFile);
    db.vacuum();
    db.close();

    console.log('');
    console.log('\x1B[1m\x1B[32m  ✔ Edge rebuild complete!\x1B[0m');
    console.log(`  └─ Connections    : \x1B[33m${edgePad.connections_created}\x1B[0m`);
    console.log('');
    return;
  }

  // 2. Scan for repos & files (restricted to scoped repos when --repos is given)
  const scanResult = scanRepoFiles(resolvedDevmind);
  const repos = scopedRepos
    ? scanResult.repos.filter(r => scopedRepos.includes(r.repo_name))
    : scanResult.repos;
  const total_files = repos.reduce((sum, r) => sum + r.files.length, 0);
  if (total_files === 0) {
    console.log('⚠️ No files found to index. Make sure config.json repositories are configured properly.');
    db.close();
    return;
  }

  // 3. Read or create scratchpad. Scoped runs always start a fresh scratchpad — they are
  // targeted re-runs, so they must not be blocked by (or resume) a prior global session.
  let pad = readScratchpad(resolvedDevmind, padFile);
  if (scopedRepos || !pad) {
    pad = createScratchpad(resolvedDevmind, total_files, padFile);
  } else if (pad.status === 'complete') {
    console.log('✅ Indexing is already completed!');
    db.close();
    return;
  }

  // =========================================================================
  // PHASE 1: NODE & CODE SNAPSHOT EXTRACTION
  // =========================================================================
  const progress = new ProgressDisplay();

  if (pad.phase === 1) {
    const reposDone = new Set(pad.repos_done);
    const allFiles: { repoName: string; absolutePath: string }[] = [];
    for (const repo of repos) {
      if (reposDone.has(repo.repo_name)) continue;
      for (const f of repo.files) {
        allFiles.push({ repoName: repo.repo_name, absolutePath: f });
      }
    }

    let startIndex = 0;
    if (pad.last_file_indexed) {
      const idx = allFiles.findIndex(f => f.absolutePath === pad!.last_file_indexed);
      if (idx !== -1) startIndex = idx + 1;
    }

    // Use pad.files_total as true total so resume shows e.g. 14/1068, not 1/1055
    progress.startPhase(1, 'Node & Code Extraction', pad.files_total, pad.files_done);

    let fileIndex = startIndex;
    for (; fileIndex < allFiles.length; fileIndex++) {
      const fileObj = allFiles[fileIndex];
      const relPath = path.relative(process.cwd(), fileObj.absolutePath);

      progress.beginItem(relPath);

      let code = '';
      try {
        code = fs.readFileSync(fileObj.absolutePath, 'utf-8');
      } catch (err) {
        progress.skipItem(`read error: ${(err as Error).message}`);
        continue;
      }

      if (code.trim().length === 0) {
        pad.files_done++;
        pad.last_file_indexed = fileObj.absolutePath;
        writeScratchpad(resolvedDevmind, pad, padFile);
        progress.skipItem('empty file');
        continue;
      }

      const fileLines = code.split('\n').length;
      progress.updateStatus(`Reading ${fileLines} lines — sending to AI…`);

      let result: ExtractionResult = {};
      try {
        result = await extractNodesFromCode(
          opts.provider,
          modelName,
          opts.key,
          opts.url,
          fileObj.absolutePath,
          code,
          getVertexToken,
          vertexProjectId,
          vertexLocation,
          progress,
          chunkSize,
          chunkOverlap
        );
      } catch (err) {
        progress.finishPhase(`Paused — API error. Run again to resume.`);
        console.error(`❌ ${(err as Error).message}`);
        db.close();
        process.exit(1);
      }

      let newNodesCount = 0;
      const totalNodesFound = result.nodes?.length ?? 0;
      if (totalNodesFound === 0) {
        progress.log(`\x1B[90mNo nodes found in file\x1B[0m`);
      }
      if (result.nodes && Array.isArray(result.nodes)) {
        for (const n of result.nodes) {
          if (n.node_id && n.name && n.type) {
            // Estimate which line the node starts on by finding its code in the file
            let lineNum = '?';
            if (n.code_snapshot) {
              const snippet = n.code_snapshot.trimStart().substring(0, 60);
              const pos = code.indexOf(snippet.substring(0, 40));
              if (pos !== -1) {
                lineNum = String(code.substring(0, pos).split('\n').length);
              }
            }
            const pctDone = fileLines > 0 ? Math.round((parseInt(lineNum) / fileLines) * 100) : 0;
            const lineTag = lineNum !== '?' ? `\x1B[90mL${lineNum}/${fileLines} (${pctDone}% through file)\x1B[0m` : `\x1B[90m(line unknown)\x1B[0m`;
            progress.log(`\x1B[32m+\x1B[0m \x1B[1m${n.name}\x1B[0m \x1B[90m[${n.type}]\x1B[0m  ${lineTag}`);
            const repoRelPath = db.toRepoRelativePath(fileObj.absolutePath);
            const qualifiedId = `${repoRelPath}#${n.node_id}`;

            db.upsertNode({
              id: qualifiedId,
              name: n.name,
              type: n.type,
              file_path: fileObj.absolutePath,
              signature: n.signature || null
            });
            newNodesCount++;
            if (n.code_snapshot) {
              db.updateHistory({
                node_id: qualifiedId,
                code_snapshot: n.code_snapshot,
                reasoning: {
                  what_changed: 'Initial code extraction during background indexing',
                  why: 'Initial index setup',
                  goal: 'Establish baseline codebase knowledge graph',
                  developer: 'devsmind background indexer',
                  model: modelName
                }
              });
              progress.log(`  \x1B[90m└ code snapshot saved (${n.code_snapshot.split('\n').length} lines)\x1B[0m`);
            }
          }
        }
      }

      pad.files_done++;
      pad.nodes_created += newNodesCount;
      pad.last_file_indexed = fileObj.absolutePath;
      pad.current_repo = fileObj.repoName;
      pad.updated_at = new Date().toISOString();

      const currentRepoFiles = repos.find(r => r.repo_name === fileObj.repoName)?.files || [];
      const isRepoDone = currentRepoFiles.length > 0 && currentRepoFiles[currentRepoFiles.length - 1] === fileObj.absolutePath;
      if (isRepoDone && !pad.repos_done.includes(fileObj.repoName)) {
        pad.repos_done.push(fileObj.repoName);
      }
      writeScratchpad(resolvedDevmind, pad, padFile);

      progress.completeItem(`${pad.nodes_created} node(s) found so far`);

      if (opts.provider === 'gemini' || opts.provider === 'vertex') await sleep(2000);
      else await sleep(200);
    }

    const activeNodes = db.listNodes();
    progress.finishPhase(`Phase 1 done — ${activeNodes.length} node(s) extracted from ${pad.files_done} file(s)`);

    if (nodesOnly) {
      pad.status = 'complete';
      pad.updated_at = new Date().toISOString();
      writeScratchpad(resolvedDevmind, pad, padFile);
    } else {
      // Transition to Phase 2
      pad.phase = 2;
      pad.nodes_total = activeNodes.length;
      pad.nodes_done = 0;
      pad.updated_at = new Date().toISOString();
      writeScratchpad(resolvedDevmind, pad, padFile);
    }
  }

  // =========================================================================
  // PHASE 2: AI CONNECTION RESOLUTION / LINKING
  // =========================================================================
  if (pad.phase === 2 && !nodesOnly) {
    const allNodes = db.listNodes();
    const allNodeIds = allNodes.map(n => n.id);
    // Candidates are always all nodes; when scoped we only (re)build edges from the
    // named repos' nodes and clear just those first so we don't wipe other repos' edges.
    const activeNodes = scopedRepos ? allNodes.filter(n => inScope(n.id)) : allNodes;
    const resumeIndex = pad.nodes_done || 0;
    if (scopedRepos && resumeIndex === 0) {
      console.log(`🧹 Clearing connections for ${activeNodes.length} node(s) in scope...`);
      db.clearConnectionsForSources(activeNodes.map(n => n.id));
    }
    pad.nodes_total = activeNodes.length;
    // Use total node count and resume offset so bar shows true progress
    progress.startPhase(2, 'AI Connection Resolution', activeNodes.length, resumeIndex);

    let nodeIndex = resumeIndex;
    for (; nodeIndex < activeNodes.length; nodeIndex++) {
      const node = activeNodes[nodeIndex];

      progress.beginItem(node.id);

      const latestCode = db.getLatestCode(node.id);
      if (!latestCode || !latestCode.code_snapshot || latestCode.code_snapshot.trim().length === 0) {
        pad.nodes_done = nodeIndex + 1;
        pad.updated_at = new Date().toISOString();
        writeScratchpad(resolvedDevmind, pad, padFile);
        progress.skipItem('no code snapshot');
        continue;
      }

      progress.updateStatus(`Resolving connections locally via AST…`);
      const connections = resolveConnectionsLocally(node.id, node.file_path, allNodes, resolvedDevmind);

      let addedCount = 0;
      for (const targetId of connections) {
        if (allNodeIds.includes(targetId)) {
          progress.log(`Linked: \x1B[36m${node.id}\x1B[0m → \x1B[36m${targetId}\x1B[0m`);
          db.addConnection(node.id, targetId);
          addedCount++;
        }
      }

      pad.nodes_done = nodeIndex + 1;
      pad.connections_created += addedCount;
      pad.updated_at = new Date().toISOString();
      writeScratchpad(resolvedDevmind, pad, padFile);

      progress.completeItem(`${pad.connections_created} connection(s) created so far`);
    }

    progress.finishPhase(`Phase 2 done — ${pad.connections_created} connection(s) linked across ${pad.nodes_total} node(s)`);
  }

  // Mark indexing session as fully complete
  pad.status = 'complete';
  pad.updated_at = new Date().toISOString();
  writeScratchpad(resolvedDevmind, pad, padFile);
  db.vacuum();
  db.close();

  console.log('');
  console.log('\x1B[1m\x1B[32m  ✔ Indexing complete!\x1B[0m');
  console.log(`  ├─ Files indexed  : \x1B[33m${pad.files_done}\x1B[0m`);
  console.log(`  ├─ Nodes created  : \x1B[33m${pad.nodes_created}\x1B[0m`);
  console.log(`  └─ Connections    : \x1B[33m${pad.connections_created}\x1B[0m`);
  console.log('');
}

export async function runBackgroundReindexing(opts: {
  devmindPath: string;
  provider: 'gemini' | 'vertex' | 'ollama';
  model?: string;
  key?: string;
  url?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  /** @deprecated Connections are always resolved locally via AST now. Accepted as a no-op for backward compatibility. */
  localEdges?: boolean;
}) {
  const resolvedDevmind = path.resolve(opts.devmindPath);
  const chunkSize = opts.chunkSize;
  const chunkOverlap = opts.chunkOverlap;

  console.log(`\n🧠 DevsMind Background Reindexer`);
  console.log(`   Brain directory : ${resolvedDevmind}`);
  console.log(`   Provider        : ${opts.provider}`);
  console.log(`   Connections     : local AST resolution (always)`);
  console.log(`   Chunking        : ${chunkSize ? `${chunkSize} lines (overlap: ${chunkOverlap ?? 50})` : 'off — whole file per call'}`);

  let modelName = opts.model || '';
  let vertexSaData: any = null;
  let vertexToken: string | null = null;
  let vertexProjectId = '';
  let vertexLocation = 'us-central1';

  if (opts.provider === 'gemini') {
    modelName = modelName || 'gemini-2.0-flash';
    const apiKey = opts.key || process.env.GEMINI_API_KEY || '';
    if (!apiKey) {
      console.error('❌ Error: Gemini API key is required. Pass --key or set GEMINI_API_KEY environment variable.');
      process.exit(1);
    }
    opts.key = apiKey;
  } else if (opts.provider === 'vertex') {
    modelName = modelName || 'gemini-1.5-flash';
    const inputKey = opts.key || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.VERTEX_API_KEY || process.env.GEMINI_API_KEY || '';
    if (!inputKey) {
      console.error('❌ Error: Vertex AI requires a Service Account JSON path or Bearer Token. Pass --key or set GOOGLE_APPLICATION_CREDENTIALS / VERTEX_API_KEY environment variable.');
      process.exit(1);
    }

    try {
      if (inputKey.trim().startsWith('{')) {
        vertexSaData = JSON.parse(inputKey);
      } else if (fs.existsSync(inputKey)) {
        vertexSaData = JSON.parse(fs.readFileSync(inputKey, 'utf-8'));
      }
    } catch (e) {
      // Treat as raw token
    }

    vertexProjectId = vertexSaData?.project_id || process.env.GCP_PROJECT_ID || process.env.VERTEX_PROJECT_ID || '';
    vertexLocation = process.env.GCP_LOCATION || process.env.VERTEX_LOCATION || 'us-central1';

    if (!vertexSaData && !inputKey.startsWith('ya29.')) {
      console.error('❌ Error: Vertex key must be a valid Service Account JSON file path, inline JSON, or raw OAuth access token starting with "ya29."');
      process.exit(1);
    }

    if (!vertexProjectId) {
      console.error('❌ Error: Vertex Project ID could not be determined. Please set GCP_PROJECT_ID environment variable or specify it in your service account JSON.');
      process.exit(1);
    }

    if (!vertexSaData) {
      vertexToken = inputKey; // Raw Bearer token
    }
  } else {
    modelName = modelName || 'qwen2.5-coder';
    opts.url = opts.url || 'http://localhost:11434';
  }

  const getVertexToken = async (): Promise<string> => {
    if (vertexToken) return vertexToken;
    if (vertexSaData) {
      return await getVertexTokenCached(vertexSaData);
    }
    throw new Error('No Vertex credentials available');
  };

  console.log(`   Model           : ${modelName}`);

  // 1. Open DB
  const dbFile = path.join(resolvedDevmind, 'brain.db');
  const db = new DevMindDatabase(dbFile);

  // 2. Initial Index Check
  const pad = readScratchpad(resolvedDevmind);
  if (!pad || pad.status !== 'complete') {
    console.error("❌ Error: Initial indexing has not been completed. Please run 'devsmind index --run' first.");
    db.close();
    process.exit(1);
  }

  // 3. Scan for repos & files
  const { repos, total_files } = scanRepoFiles(resolvedDevmind);
  if (total_files === 0) {
    console.log('⚠️ No files found to reindex.');
    db.close();
    return;
  }

  // 4. Retrieve last reindexing timestamp
  const lastReindexVal = db.getSystemMeta('last_reindex_at');
  const lastReindexTime = lastReindexVal ? new Date(lastReindexVal).getTime() : 0;
  console.log(`   Last reindex    : ${lastReindexVal ? new Date(lastReindexVal).toLocaleString() : 'Never'}`);

  // 5. Detect modified or newly added files
  const modifiedFiles: { repoName: string; absolutePath: string }[] = [];
  for (const repo of repos) {
    for (const f of repo.files) {
      try {
        const stat = fs.statSync(f);
        if (stat.mtimeMs > lastReindexTime) {
          modifiedFiles.push({ repoName: repo.repo_name, absolutePath: f });
        }
      } catch (err) {
        // ignore errors
      }
    }
  }

  if (modifiedFiles.length === 0) {
    console.log('\n✅ Code graph is already up to date. No modified files detected.');
    db.setSystemMeta('last_reindex_at', new Date().toISOString());
    db.close();
    return;
  }

  console.log(`\n📝 Detected ${modifiedFiles.length} modified/new file(s) since last reindex.`);

  // 6. Extraction & Upserting of modified nodes
  const progress = new ProgressDisplay();
  progress.startPhase(1, 'Incremental Node Extraction', modifiedFiles.length, 0);

  const newOrUpdatedNodeIds: string[] = [];
  // Source nodes (in possibly-unmodified files) that had edges pointing INTO the modified
  // files. deprecateNode below deletes those inbound edges, so we capture their sources here
  // and re-resolve them after Phase 2 to rebuild the "used-by" edges (else every reindex
  // silently strips incoming edges from unmodified callers).
  const inboundSourceIds = new Set<string>();

  for (let fileIndex = 0; fileIndex < modifiedFiles.length; fileIndex++) {
    const fileObj = modifiedFiles[fileIndex];
    const relPath = path.relative(process.cwd(), fileObj.absolutePath);

    progress.beginItem(relPath);

    let code = '';
    try {
      code = fs.readFileSync(fileObj.absolutePath, 'utf-8');
    } catch (err) {
      progress.skipItem(`read error: ${(err as Error).message}`);
      continue;
    }

    // Deprecate existing nodes for this file path before parsing. Capture inbound-edge
    // sources FIRST (deprecateNode deletes edges in both directions).
    const oldNodes = db.getNodesByFilePath(fileObj.absolutePath);
    for (const oldNode of oldNodes) {
      for (const src of db.getInboundSources(oldNode.id)) inboundSourceIds.add(src);
      db.deprecateNode(oldNode.id);
    }

    if (code.trim().length === 0) {
      progress.skipItem('empty file');
      continue;
    }

    const fileLines = code.split('\n').length;
    progress.updateStatus(`Reading ${fileLines} lines — sending to AI…`);

    let result: ExtractionResult = {};
    try {
      result = await extractNodesFromCode(
        opts.provider,
        modelName,
        opts.key,
        opts.url,
        fileObj.absolutePath,
        code,
        getVertexToken,
        vertexProjectId,
        vertexLocation,
        progress,
        chunkSize,
        chunkOverlap
      );
    } catch (err) {
      progress.finishPhase(`Paused — API error.`);
      console.error(`❌ ${(err as Error).message}`);
      db.close();
      process.exit(1);
    }

    let fileNodesCount = 0;
    if (result.nodes && Array.isArray(result.nodes)) {
      for (const n of result.nodes) {
        if (n.node_id && n.name && n.type) {
          let lineNum = '?';
          if (n.code_snapshot) {
            const snippet = n.code_snapshot.trimStart().substring(0, 60);
            const pos = code.indexOf(snippet.substring(0, 40));
            if (pos !== -1) {
              lineNum = String(code.substring(0, pos).split('\n').length);
            }
          }
          const pctDone = fileLines > 0 ? Math.round((parseInt(lineNum) / fileLines) * 100) : 0;
          const lineTag = lineNum !== '?' ? `\x1B[90mL${lineNum}/${fileLines} (${pctDone}% through file)\x1B[0m` : `\x1B[90m(line unknown)\x1B[0m`;
          progress.log(`\x1B[32m+\x1B[0m \x1B[1m${n.name}\x1B[0m \x1B[90m[${n.type}]\x1B[0m  ${lineTag}`);
          
          const repoRelPath = db.toRepoRelativePath(fileObj.absolutePath);
          const qualifiedId = `${repoRelPath}#${n.node_id}`;

          db.upsertNode({
            id: qualifiedId,
            name: n.name,
            type: n.type,
            file_path: fileObj.absolutePath,
            signature: n.signature || null
          });
          fileNodesCount++;
          newOrUpdatedNodeIds.push(qualifiedId);

          if (n.code_snapshot) {
            db.updateHistory({
              node_id: qualifiedId,
              code_snapshot: n.code_snapshot,
              reasoning: {
                what_changed: 'Incremental code extraction during reindexing',
                why: 'Incremental graph sync',
                goal: 'Synchronize graph nodes with updated codebase files',
                developer: 'devsmind reindexer',
                model: modelName
              }
            });
          }
        }
      }
    }

    progress.completeItem(`${fileNodesCount} node(s) found`);

    if (opts.provider === 'gemini' || opts.provider === 'vertex') await sleep(2000);
    else await sleep(200);
  }

  progress.finishPhase(`Phase 1 done — parsed ${modifiedFiles.length} file(s), found ${newOrUpdatedNodeIds.length} new/updated node(s)`);

  // Phase 2: Resolving connections for modified nodes
  if (newOrUpdatedNodeIds.length > 0) {
    const activeNodes = db.listNodes();
    const allNodeIds = activeNodes.map(n => n.id);
    
    progress.startPhase(2, 'Incremental Connection Resolution', newOrUpdatedNodeIds.length, 0);

    for (let nodeIndex = 0; nodeIndex < newOrUpdatedNodeIds.length; nodeIndex++) {
      const nodeId = newOrUpdatedNodeIds[nodeIndex];
      progress.beginItem(nodeId);

      const latestCode = db.getLatestCode(nodeId);
      if (!latestCode || !latestCode.code_snapshot || latestCode.code_snapshot.trim().length === 0) {
        progress.skipItem('no code snapshot');
        continue;
      }

      progress.updateStatus(`Resolving connections locally via AST…`);
      let connections: string[] = [];
      const nodeObj = db.getNode(nodeId);
      if (nodeObj && nodeObj.file_path) {
        connections = resolveConnectionsLocally(nodeId, nodeObj.file_path, activeNodes, resolvedDevmind);
      }

      let connectionsAdded = 0;
      for (const targetId of connections) {
        if (allNodeIds.includes(targetId)) {
          progress.log(`Linked: \x1B[36m${nodeId}\x1B[0m → \x1B[36m${targetId}\x1B[0m`);
          db.addConnection(nodeId, targetId);
          connectionsAdded++;
        }
      }

      progress.completeItem(`${connectionsAdded} connection(s) created`);
    }

    progress.finishPhase('Phase 2 done — finished reindexing connections');
  }

  // Phase 2b: rebuild inbound edges. Callers in unmodified files had their edges into the
  // modified files deleted by deprecateNode; re-resolve those callers so their links to the
  // modified files' NEW nodes are restored (addConnection is idempotent for unchanged edges).
  const reresolveSources = [...inboundSourceIds].filter(
    id => !newOrUpdatedNodeIds.includes(id) && db.getNode(id)
  );
  if (reresolveSources.length > 0) {
    const activeNodes = db.listNodes();
    const allNodeIds = new Set(activeNodes.map(n => n.id));
    progress.startPhase(2, 'Inbound Edge Rebuild', reresolveSources.length, 0);
    for (const srcId of reresolveSources) {
      progress.beginItem(srcId);
      const srcNode = db.getNode(srcId);
      if (!srcNode || !srcNode.file_path) { progress.skipItem('missing'); continue; }
      const conns = resolveConnectionsLocally(srcId, srcNode.file_path, activeNodes, resolvedDevmind);
      let added = 0;
      for (const targetId of conns) {
        if (allNodeIds.has(targetId)) { db.addConnection(srcId, targetId); added++; }
      }
      progress.completeItem(`${added} connection(s)`);
    }
    progress.finishPhase('Phase 2b done — inbound edges rebuilt');
  }

  // Update last_reindex_at
  db.setSystemMeta('last_reindex_at', new Date().toISOString());
  db.vacuum();
  db.close();

  console.log('\n\x1B[1m\x1B[32m  ✔ Reindexing complete!\x1B[0m\n');
}
