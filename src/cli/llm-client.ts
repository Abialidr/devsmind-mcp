import * as fs from 'fs';
import * as crypto from 'crypto';
import { makeHttpRequest, sleep, getVertexTokenCached } from './runner';
import { safeJsonParse } from '../utils/json';

/**
 * A general-purpose "send a prompt, get text back" client, separate from `runner.ts`'s
 * `extractWith*` functions — those have the node-extraction system prompt hardcoded in their
 * bodies with no way to swap it out. This is the missing piece for anything that needs to talk
 * to the same providers with a DIFFERENT prompt (currently: the `devsmind describe` backfill).
 * Deliberately does not touch `extractWith*` — this reuses their transport/auth primitives
 * (`makeHttpRequest`, `getVertexTokenCached`, exported from `runner.ts`) rather than refactoring
 * working code that has its own, more elaborate (ProgressDisplay-coupled) retry logic already.
 */

export type LlmProvider = 'gemini' | 'vertex' | 'ollama';

export interface LlmCredentials {
  provider: LlmProvider;
  model: string;
  apiKey?: string; // gemini
  vertexSaData?: any; // vertex — service account JSON, when available
  vertexToken?: string; // vertex — raw bearer token, when no service account
  vertexProjectId?: string; // vertex
  vertexLocation?: string; // vertex
  url?: string; // ollama
}

/**
 * Resolves credentials for a provider from an explicit `--key`/`--url` or the environment,
 * mirroring the precedence `runBackgroundIndexing`/`runBackgroundReindexing` already use —
 * but THROWS instead of calling `process.exit`, so a library caller (like `devsmind describe`)
 * can catch it and decide how to report the failure itself, rather than the process dying
 * inside a function with no return value.
 */
export function resolveLlmCredentials(opts: { provider: LlmProvider; model?: string; key?: string; url?: string }): LlmCredentials {
  if (opts.provider === 'gemini') {
    const model = opts.model || 'gemini-2.0-flash';
    const apiKey = opts.key || process.env.GEMINI_API_KEY || '';
    if (!apiKey) throw new Error('Gemini API key is required. Pass --key or set GEMINI_API_KEY environment variable.');
    return { provider: 'gemini', model, apiKey };
  }

  if (opts.provider === 'vertex') {
    const model = opts.model || 'gemini-1.5-flash';
    const inputKey = opts.key || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.VERTEX_API_KEY || process.env.GEMINI_API_KEY || '';
    if (!inputKey) {
      throw new Error('Vertex AI requires a Service Account JSON path or Bearer Token. Pass --key or set GOOGLE_APPLICATION_CREDENTIALS / VERTEX_API_KEY environment variable.');
    }

    let vertexSaData: any = null;
    try {
      if (inputKey.trim().startsWith('{')) {
        vertexSaData = JSON.parse(inputKey);
      } else if (fs.existsSync(inputKey)) {
        vertexSaData = JSON.parse(fs.readFileSync(inputKey, 'utf-8'));
      }
    } catch {
      // Treat as a raw token below.
    }

    const vertexProjectId = vertexSaData?.project_id || process.env.GCP_PROJECT_ID || process.env.VERTEX_PROJECT_ID || '';
    const vertexLocation = process.env.GCP_LOCATION || process.env.VERTEX_LOCATION || 'us-central1';

    if (!vertexSaData && !inputKey.startsWith('ya29.')) {
      throw new Error('Vertex key must be a valid Service Account JSON file path, inline JSON, or raw OAuth access token starting with "ya29."');
    }
    if (!vertexProjectId) {
      throw new Error('Vertex Project ID could not be determined. Please set GCP_PROJECT_ID environment variable or specify it in your service account JSON.');
    }

    return {
      provider: 'vertex',
      model,
      vertexSaData: vertexSaData || undefined,
      vertexToken: vertexSaData ? undefined : inputKey,
      vertexProjectId,
      vertexLocation
    };
  }

  // ollama
  return { provider: 'ollama', model: opts.model || 'qwen2.5-coder', url: opts.url || 'http://localhost:11434' };
}

/** One prompt round-trip to whichever provider `creds` resolved to. Every provider is asked
 * for a raw JSON response (no markdown fences) — callers parse with `safeJsonParse`, which
 * already tolerates a fenced or slightly truncated response if a provider ignores that ask. */
export async function sendPrompt(creds: LlmCredentials, systemPrompt: string, userPrompt: string): Promise<string> {
  if (creds.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${creds.model}:generateContent?key=${creds.apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { responseMimeType: 'application/json' }
    };
    const responseText = await makeHttpRequest(url, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify(payload));
    const parsed = safeJsonParse(responseText, {} as any);
    return parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (creds.provider === 'vertex') {
    const token = creds.vertexToken || await getVertexTokenCached(creds.vertexSaData);
    const url = `https://${creds.vertexLocation}-aiplatform.googleapis.com/v1/projects/${creds.vertexProjectId}/locations/${creds.vertexLocation}/publishers/google/models/${creds.model}:generateContent`;
    const payload = {
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { responseMimeType: 'application/json' }
    };
    const responseText = await makeHttpRequest(url, 'POST', { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, JSON.stringify(payload));
    const parsed = safeJsonParse(responseText, {} as any);
    return parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // ollama
  const endpoint = `${(creds.url || 'http://localhost:11434').replace(/\/$/, '')}/api/chat`;
  const payload = {
    model: creds.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: false,
    format: 'json'
  };
  const responseText = await makeHttpRequest(endpoint, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify(payload));
  const parsed = safeJsonParse(responseText, {} as any);
  return parsed.message?.content || '';
}

/**
 * `sendPrompt` with a small, independent retry — deliberately NOT the 5-attempt/`ProgressDisplay`
 * -coupled retry loop `extractNodesFromCode` uses; this caller has no TTY progress bar to update,
 * so it just logs via `onRetry` and backs off (longer on a 429, since that means "slow down",
 * shorter on anything else — a transient network blip is usually gone in a couple seconds).
 */
export async function sendPromptWithRetry(
  creds: LlmCredentials,
  systemPrompt: string,
  userPrompt: string,
  opts: { retries?: number; onRetry?: (message: string) => void } = {}
): Promise<string> {
  const maxAttempts = opts.retries ?? 3;
  let backoffMs = 5000;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await sendPrompt(creds, systemPrompt, userPrompt);
    } catch (err) {
      lastErr = err as Error;
      const isRateLimited = (lastErr.message || '').includes('429');
      if (attempt < maxAttempts) {
        opts.onRetry?.(`attempt ${attempt}/${maxAttempts} failed (${lastErr.message}) — retrying in ${isRateLimited ? backoffMs / 1000 : 2}s`);
        await sleep(isRateLimited ? backoffMs : 2000);
        if (isRateLimited) backoffMs *= 2;
      }
    }
  }
  throw lastErr || new Error('sendPrompt failed after retries');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-calling (function-calling) conversation turns — for the Phase D agentic
// curation loop (`src/cli/extract-agent.ts`). `sendPrompt` above is single-shot
// text-in/JSON-out; this is a genuine multi-turn conversation where the model can
// call tools and get their results back before producing a final answer.
//
// Each provider's native function-calling protocol differs (Gemini/Vertex share
// one shape via the Generative Language API; Ollama uses an OpenAI-style tool
// format), so the payload-building and response-parsing for each is kept as a
// SEPARATE, PURE, EXPORTED function — independently testable without a live API
// call, since the actual risk here is protocol-translation correctness, not the
// HTTP transport (already proven by `sendPrompt` above).
// ─────────────────────────────────────────────────────────────────────────────

/** A tool the model may call, in JSON-Schema-parameters form (provider-agnostic). */
export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One tool invocation the model requested. */
export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** One turn of a tool-calling conversation, in a shape every provider can express. */
export type LlmConversationMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string };

/** What the model produced this turn: free text, and/or requests to call tools. Both can be
 * present (some models narrate before calling a tool); `submit_decisions`-style loops should
 * treat any `toolCalls` entry as authoritative over `text`. */
export interface LlmTurnResult {
  text: string | null;
  toolCalls: LlmToolCall[];
}

// ── Gemini / Vertex (same Generative Language API request/response shape) ──────

/** Builds the `contents` array for a Gemini/Vertex tool-calling request. Exported so the
 * translation logic (the actual risk area) is unit-testable without a live call. */
export function buildGeminiContents(messages: LlmConversationMessage[]): unknown[] {
  return messages.map(m => {
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.content }] };
    if (m.role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls) parts.push({ functionCall: { name: tc.name, args: tc.args } });
      // Vertex/Gemini API rejects a message with an empty `parts` array (HTTP 400:
      // "must include at least one parts field"). This happens when the model returned
      // a turn with no text AND no tool calls (the "nudge" path in extract-agent.ts).
      if (parts.length === 0) parts.push({ text: '(no response)' });
      return { role: 'model', parts };
    }
    // Vertex AI's `function_response.response` is typed as `google.protobuf.Struct`,
    // which only accepts a JSON **object** — never an array or primitive. Wrap any
    // non-object parse result (e.g. `listFileImports` returns an array) in `{ result: … }`
    // so the payload is always Struct-compatible.
    let parsed: unknown;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      parsed = m.content;
    }
    const response = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed
      : { result: parsed };
    return { role: 'user', parts: [{ functionResponse: { name: m.toolName, response } }] };
  });
}

/** Builds the `tools` field shared by Gemini and Vertex. */
export function buildGeminiTools(tools: LlmTool[]): unknown[] {
  return [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
}

/** Parses a Gemini/Vertex `candidates[0].content.parts` array into the provider-agnostic turn
 * result. A part is either `{text}` or `{functionCall:{name,args}}` — Gemini assigns no id of
 * its own, so one is minted here purely as a local correlation key for the tool-result message. */
export function parseGeminiParts(parts: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[]): LlmTurnResult {
  let text: string | null = null;
  const toolCalls: LlmToolCall[] = [];
  for (const p of parts || []) {
    if (p.text) text = (text ?? '') + p.text;
    if (p.functionCall) toolCalls.push({ id: crypto.randomUUID(), name: p.functionCall.name, args: p.functionCall.args ?? {} });
  }
  return { text, toolCalls };
}

async function sendGeminiTurn(model: string, apiKey: string, systemPrompt: string, messages: LlmConversationMessage[], tools: LlmTool[]): Promise<LlmTurnResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload = {
    contents: buildGeminiContents(messages),
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: buildGeminiTools(tools)
  };
  const responseText = await makeHttpRequest(url, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify(payload));
  const parsed = safeJsonParse(responseText, {} as any);
  return parseGeminiParts(parsed.candidates?.[0]?.content?.parts || []);
}

async function sendVertexTurn(model: string, token: string, projectId: string, location: string, systemPrompt: string, messages: LlmConversationMessage[], tools: LlmTool[]): Promise<LlmTurnResult> {
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const payload = {
    contents: buildGeminiContents(messages),
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: buildGeminiTools(tools)
  };
  const responseText = await makeHttpRequest(url, 'POST', { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, JSON.stringify(payload));
  const parsed = safeJsonParse(responseText, {} as any);
  return parseGeminiParts(parsed.candidates?.[0]?.content?.parts || []);
}

// ── Ollama (OpenAI-style `tools`/`tool_calls`) ──────────────────────────────

/** Builds the `messages` array for an Ollama tool-calling chat request. */
export function buildOllamaMessages(systemPrompt: string, messages: LlmConversationMessage[]): unknown[] {
  const out: Record<string, unknown>[] = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map(tc => ({ function: { name: tc.name, arguments: tc.args } }))
      });
    } else {
      // Ollama's tool-result message has no call-id field to correlate against (same
      // one-outstanding-call-per-name constraint as Gemini above) — `tool_name` is what ties it
      // back to the request.
      out.push({ role: 'tool', tool_name: m.toolName, content: m.content });
    }
  }
  return out;
}

/** Builds the OpenAI-style `tools` field Ollama expects. */
export function buildOllamaTools(tools: LlmTool[]): unknown[] {
  return tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Parses an Ollama chat response's `message` into the provider-agnostic turn result. */
export function parseOllamaMessage(message: { content?: string; tool_calls?: { function?: { name: string; arguments?: Record<string, unknown> } }[] }): LlmTurnResult {
  const toolCalls: LlmToolCall[] = (message.tool_calls || [])
    .filter(tc => tc.function?.name)
    .map(tc => ({ id: crypto.randomUUID(), name: tc.function!.name, args: tc.function!.arguments ?? {} }));
  return { text: message.content || null, toolCalls };
}

async function sendOllamaTurn(url: string, model: string, systemPrompt: string, messages: LlmConversationMessage[], tools: LlmTool[]): Promise<LlmTurnResult> {
  const endpoint = `${url.replace(/\/$/, '')}/api/chat`;
  const payload = {
    model,
    messages: buildOllamaMessages(systemPrompt, messages),
    tools: buildOllamaTools(tools),
    stream: false
  };
  const responseText = await makeHttpRequest(endpoint, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify(payload));
  const parsed = safeJsonParse(responseText, {} as any);
  return parseOllamaMessage(parsed.message || {});
}

/** One turn of a tool-calling conversation with whichever provider `creds` resolved to. */
export async function sendConversationTurn(
  creds: LlmCredentials,
  systemPrompt: string,
  messages: LlmConversationMessage[],
  tools: LlmTool[]
): Promise<LlmTurnResult> {
  if (creds.provider === 'gemini') {
    return sendGeminiTurn(creds.model, creds.apiKey!, systemPrompt, messages, tools);
  }
  if (creds.provider === 'vertex') {
    const token = creds.vertexToken || await getVertexTokenCached(creds.vertexSaData);
    return sendVertexTurn(creds.model, token, creds.vertexProjectId!, creds.vertexLocation!, systemPrompt, messages, tools);
  }
  return sendOllamaTurn(creds.url || 'http://localhost:11434', creds.model, systemPrompt, messages, tools);
}

/** `sendConversationTurn` with the same retry/backoff shape as `sendPromptWithRetry`. */
export async function sendConversationTurnWithRetry(
  creds: LlmCredentials,
  systemPrompt: string,
  messages: LlmConversationMessage[],
  tools: LlmTool[],
  opts: { retries?: number; onRetry?: (message: string) => void } = {}
): Promise<LlmTurnResult> {
  const maxAttempts = opts.retries ?? 3;
  let backoffMs = 5000;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await sendConversationTurn(creds, systemPrompt, messages, tools);
    } catch (err) {
      lastErr = err as Error;
      const isRateLimited = (lastErr.message || '').includes('429');
      if (attempt < maxAttempts) {
        opts.onRetry?.(`attempt ${attempt}/${maxAttempts} failed (${lastErr.message}) — retrying in ${isRateLimited ? backoffMs / 1000 : 2}s`);
        await sleep(isRateLimited ? backoffMs : 2000);
        if (isRateLimited) backoffMs *= 2;
      }
    }
  }
  throw lastErr || new Error('sendConversationTurn failed after retries');
}
