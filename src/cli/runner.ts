import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { DevMindDatabase } from '../db/database';
import { readScratchpad, createScratchpad, updateScratchpad, completeScratchpad } from '../db/indexer';
import { scanRepoFiles } from '../utils/scanner';

interface ExtractedNode {
  node_id: string;
  name: string;
  type: string;
  signature?: string;
}

interface ExtractedConnection {
  source_node_id: string;
  target_node_id: string;
}

interface ExtractionResult {
  nodes?: ExtractedNode[];
  connections?: ExtractedConnection[];
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

async function extractWithGemini(
  model: string,
  key: string,
  filePath: string,
  code: string
): Promise<ExtractionResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  
  const systemPrompt = `You are a codebase indexing assistant. Your job is to analyze the source code file provided and extract all code structures (functions, methods, classes, controllers, services, interfaces, schema models, types) and caller-callee connections between them.
Return ONLY a valid JSON object matching the schema:
{
  "nodes": [
    { "node_id": "fully_qualified_identifier (e.g. Class.method or function)", "name": "display_name", "type": "type_from_taxonomy", "signature": "param/return signature (optional)" }
  ],
  "connections": [
    { "source_node_id": "fully_qualified_caller", "target_node_id": "fully_qualified_callee" }
  ]
}
${TAXONOMY_PROMPT}
CRITICAL RULES:
1. ONLY extract code structures defined in the file. Do NOT extract imports or third-party libraries as nodes.
2. DO NOT wrap JSON in markdown blocks (e.g. no \`\`\`json). Return raw JSON.
3. Be highly precise and return an empty JSON object if no code constructs are found.`;

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

  const parsed = JSON.parse(responseText);
  const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    return {};
  }
  return JSON.parse(text) as ExtractionResult;
}

async function extractWithOllama(
  url: string,
  model: string,
  filePath: string,
  code: string
): Promise<ExtractionResult> {
  const endpoint = `${url.replace(/\/$/, '')}/api/chat`;
  
  const systemPrompt = `You are a codebase indexing assistant. Analyze this source code file and extract code structures (functions, classes, methods, endpoints) and caller-callee connections.
Return ONLY a valid JSON object matching the schema:
{
  "nodes": [
    { "node_id": "unique_string (e.g. Class.method or function)", "name": "display_name", "type": "type_from_taxonomy", "signature": "param/return signature (optional)" }
  ],
  "connections": [
    { "source_node_id": "caller", "target_node_id": "callee" }
  ]
}
${TAXONOMY_PROMPT}
CRITICAL RULES:
1. ONLY extract constructs defined in this file. Do NOT extract third-party libraries or imports.
2. Return a clean, valid JSON object.`;

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

  const parsed = JSON.parse(responseText);
  const text = parsed.message?.content;
  if (!text) {
    return {};
  }
  return JSON.parse(text) as ExtractionResult;
}

export async function runBackgroundIndexing(opts: {
  devmindPath: string;
  provider: 'gemini' | 'ollama';
  model?: string;
  key?: string;
  url?: string;
}) {
  const resolvedDevmind = path.resolve(opts.devmindPath);
  console.log(`\n🧠 DevsMind Background Indexer`);
  console.log(`   Brain directory : ${resolvedDevmind}`);
  console.log(`   Provider        : ${opts.provider}`);
  
  let modelName = opts.model || '';
  if (opts.provider === 'gemini') {
    modelName = modelName || 'gemini-2.0-flash';
    const apiKey = opts.key || process.env.GEMINI_API_KEY || '';
    if (!apiKey) {
      console.error('❌ Error: Gemini API key is required. Pass --key or set GEMINI_API_KEY environment variable.');
      process.exit(1);
    }
    opts.key = apiKey;
  } else {
    modelName = modelName || 'qwen2.5-coder';
    opts.url = opts.url || 'http://localhost:11434';
  }
  console.log(`   Model           : ${modelName}`);

  // 1. Scan for repos & files
  const { repos, total_files } = scanRepoFiles(resolvedDevmind);
  if (total_files === 0) {
    console.log('⚠️ No files found to index. Make sure config.json repositories are configured properly.');
    return;
  }

  // 2. Open DB
  const dbFile = path.join(resolvedDevmind, 'brain.db');
  const db = new DevMindDatabase(dbFile);

  // 3. Read or create scratchpad
  let pad = readScratchpad(resolvedDevmind);
  if (!pad) {
    pad = createScratchpad(resolvedDevmind, total_files);
  } else if (pad.status === 'complete') {
    console.log('✅ Indexing is already completed!');
    db.close();
    return;
  }

  const reposDone = new Set(pad.repos_done);
  
  // Flatten file list for tracking
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
    if (idx !== -1) {
      startIndex = idx + 1;
    }
  }

  console.log(`   Progress        : ${pad.files_done}/${pad.files_total} files (${Math.round((pad.files_done / pad.files_total) * 100)}%)`);
  console.log(`   Remaining Files : ${allFiles.length - startIndex} file(s)`);
  console.log('──────────────────────────────────────────────────\n');

  let fileIndex = startIndex;
  let successCount = 0;

  for (; fileIndex < allFiles.length; fileIndex++) {
    const fileObj = allFiles[fileIndex];
    const relPath = path.relative(process.cwd(), fileObj.absolutePath);
    console.log(`[${pad.files_done + 1}/${pad.files_total}] Indexing: ${relPath}...`);

    let code = '';
    try {
      code = fs.readFileSync(fileObj.absolutePath, 'utf-8');
    } catch (err) {
      console.warn(`⚠️ Warning: Failed to read file ${fileObj.absolutePath}: ${(err as Error).message}`);
      continue;
    }

    if (code.trim().length === 0) {
      // Empty file
      pad.files_done++;
      pad.last_file_indexed = fileObj.absolutePath;
      updateScratchpad(resolvedDevmind, {
        files_done: pad.files_done,
        last_file_indexed: pad.last_file_indexed
      });
      continue;
    }

    let result: ExtractionResult = {};
    let retries = 3;
    while (retries > 0) {
      try {
        if (opts.provider === 'gemini') {
          result = await extractWithGemini(modelName, opts.key!, fileObj.absolutePath, code);
        } else {
          result = await extractWithOllama(opts.url!, modelName, fileObj.absolutePath, code);
        }
        break;
      } catch (err) {
        retries--;
        console.error(`   ⚠️ API Error: ${(err as Error).message}. Retries left: ${retries}`);
        if (retries === 0) {
          console.error('❌ Indexing paused. Run this command again to resume.');
          db.close();
          process.exit(1);
        }
        await sleep(2000);
      }
    }

    // 4. Save extracted nodes and connections directly to DB
    let newNodes = 0;
    let newConns = 0;

    if (result.nodes && Array.isArray(result.nodes)) {
      for (const n of result.nodes) {
        if (n.node_id && n.name && n.type) {
          db.upsertNode({
            id: n.node_id,
            name: n.name,
            type: n.type,
            file_path: fileObj.absolutePath,
            signature: n.signature || null
          });
          newNodes++;
        }
      }
    }

    if (result.connections && Array.isArray(result.connections)) {
      for (const c of result.connections) {
        if (c.source_node_id && c.target_node_id) {
          db.addConnection(c.source_node_id, c.target_node_id);
          newConns++;
        }
      }
    }

    // Update progress
    pad.files_done++;
    pad.nodes_created += newNodes;
    pad.connections_created += newConns;
    pad.last_file_indexed = fileObj.absolutePath;
    pad.current_repo = fileObj.repoName;

    // Check if the repository is fully indexed
    const currentRepoFiles = repos.find(r => r.repo_name === fileObj.repoName)?.files || [];
    const isRepoDone = currentRepoFiles.length > 0 && currentRepoFiles[currentRepoFiles.length - 1] === fileObj.absolutePath;
    if (isRepoDone && !pad.repos_done.includes(fileObj.repoName)) {
      pad.repos_done.push(fileObj.repoName);
    }

    updateScratchpad(resolvedDevmind, {
      files_done: pad.files_done,
      last_file_indexed: pad.last_file_indexed,
      nodes_created: pad.nodes_created,
      connections_created: pad.connections_created,
      current_repo: pad.current_repo,
      repos_done: pad.repos_done
    });

    console.log(`   Success: Created ${newNodes} node(s), ${newConns} connection(s).`);
    successCount++;

    // Respect Gemini AI Studio Free Tier limit (15 Requests/Min -> 1 request every 4 seconds)
    if (opts.provider === 'gemini') {
      await sleep(4000);
    } else {
      // Short breather for local CPU/GPU to not cook
      await sleep(200);
    }
  }

  // Mark complete
  completeScratchpad(resolvedDevmind);
  db.vacuum();
  db.close();
  console.log('\n🎉 Indexing finished completely!');
  console.log(`   Total Files Indexed  : ${pad.files_done}`);
  console.log(`   Total Nodes Created  : ${pad.nodes_created}`);
  console.log(`   Total Conns Created  : ${pad.connections_created}`);
  console.log('──────────────────────────────────────────────────\n');
}
