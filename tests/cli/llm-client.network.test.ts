import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// This file covers the NETWORK-calling surface of src/cli/llm-client.ts:
//   - resolveLlmCredentials (env/opts resolution + throwing on missing creds)
//   - sendPrompt / sendPromptWithRetry (transport + retry/backoff policy)
//   - sendConversationTurn / sendConversationTurnWithRetry (provider dispatch wiring)
//
// The pure translator functions (buildGeminiContents, parseGeminiParts, buildOllamaMessages,
// parseOllamaMessage, ...) are covered elsewhere — here we trust them and only verify the wiring.
//
// llm-client.ts imports { makeHttpRequest, sleep, getVertexTokenCached } from './runner'. Rather
// than mocking the http/https transport underneath runner.ts (which would also drag in
// runner.ts's heavy transitive deps — DevMindDatabase, extract-agent, etc.), we mock the whole
// `../../src/cli/runner` module and control those three functions directly. This is exactly the
// "mock the specific imported helper function directly" option called out for this file, and it
// keeps retry/backoff tests fast without needing fake timers — our mocked `sleep` just resolves
// immediately while still recording what delay it was asked for.

jest.mock('../../src/cli/runner', () => ({
  makeHttpRequest: jest.fn(),
  sleep: jest.fn(() => Promise.resolve()),
  getVertexTokenCached: jest.fn(),
}));

import * as runner from '../../src/cli/runner';
import {
  resolveLlmCredentials,
  sendPrompt,
  sendPromptWithRetry,
  sendConversationTurn,
  sendConversationTurnWithRetry,
  LlmCredentials,
  LlmConversationMessage,
  LlmTool,
} from '../../src/cli/llm-client';

const mockMakeHttpRequest = runner.makeHttpRequest as jest.Mock;
const mockSleep = runner.sleep as jest.Mock;
const mockGetVertexTokenCached = runner.getVertexTokenCached as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'VERTEX_API_KEY', 'GCP_PROJECT_ID', 'VERTEX_PROJECT_ID', 'GCP_LOCATION', 'VERTEX_LOCATION']) {
    delete process.env[key];
  }
}

beforeEach(() => {
  resetEnv();
  mockMakeHttpRequest.mockReset();
  mockSleep.mockReset().mockImplementation(() => Promise.resolve());
  mockGetVertexTokenCached.mockReset();
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveLlmCredentials
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveLlmCredentials', () => {
  describe('gemini', () => {
    it('uses opts.model / opts.key when given', () => {
      const creds = resolveLlmCredentials({ provider: 'gemini', model: 'gemini-1.5-pro', key: 'k-explicit' });
      expect(creds).toEqual({ provider: 'gemini', model: 'gemini-1.5-pro', apiKey: 'k-explicit' });
    });

    it('defaults model to gemini-2.0-flash and reads the key from GEMINI_API_KEY when omitted', () => {
      process.env.GEMINI_API_KEY = 'k-from-env';
      const creds = resolveLlmCredentials({ provider: 'gemini' });
      expect(creds).toEqual({ provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'k-from-env' });
    });

    it('throws a clear error when no key is available anywhere', () => {
      expect(() => resolveLlmCredentials({ provider: 'gemini' })).toThrow(/Gemini API key is required/);
    });
  });

  describe('ollama', () => {
    it('defaults model to qwen2.5-coder and url to http://localhost:11434', () => {
      const creds = resolveLlmCredentials({ provider: 'ollama' });
      expect(creds).toEqual({ provider: 'ollama', model: 'qwen2.5-coder', url: 'http://localhost:11434' });
    });

    it('honors opts.model / opts.url overrides', () => {
      const creds = resolveLlmCredentials({ provider: 'ollama', model: 'llama3', url: 'http://box:9999' });
      expect(creds).toEqual({ provider: 'ollama', model: 'llama3', url: 'http://box:9999' });
    });
  });

  describe('vertex', () => {
    let tmpDir: string;
    let saPath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-vertex-sa-'));
      saPath = path.join(tmpDir, 'sa.json');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('throws when no key/credentials source is available at all', () => {
      expect(() => resolveLlmCredentials({ provider: 'vertex' })).toThrow(
        /Vertex AI requires a Service Account JSON path or Bearer Token/
      );
    });

    it('reads a service-account JSON file from disk and extracts project_id/client_email/private_key', () => {
      const sa = {
        type: 'service_account',
        project_id: 'my-gcp-project',
        private_key_id: 'pk-id',
        private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
        client_email: 'svc@my-gcp-project.iam.gserviceaccount.com',
        token_uri: 'https://oauth2.googleapis.com/token',
      };
      fs.writeFileSync(saPath, JSON.stringify(sa));

      const creds = resolveLlmCredentials({ provider: 'vertex', key: saPath });
      expect(creds.provider).toBe('vertex');
      expect(creds.model).toBe('gemini-1.5-flash');
      expect(creds.vertexSaData).toMatchObject({
        project_id: 'my-gcp-project',
        client_email: 'svc@my-gcp-project.iam.gserviceaccount.com',
        private_key: sa.private_key,
      });
      expect(creds.vertexToken).toBeUndefined();
      expect(creds.vertexProjectId).toBe('my-gcp-project');
      expect(creds.vertexLocation).toBe('us-central1');
    });

    it('accepts inline service-account JSON (a string starting with "{") via opts.key', () => {
      const sa = { project_id: 'inline-project', client_email: 'x@y.iam.gserviceaccount.com', private_key: 'PK' };
      const creds = resolveLlmCredentials({ provider: 'vertex', key: JSON.stringify(sa) });
      expect(creds.vertexProjectId).toBe('inline-project');
      expect(creds.vertexSaData.client_email).toBe('x@y.iam.gserviceaccount.com');
    });

    it('reads GOOGLE_APPLICATION_CREDENTIALS from env when opts.key is omitted', () => {
      const sa = { project_id: 'env-project', client_email: 'e@e.iam.gserviceaccount.com', private_key: 'PK' };
      fs.writeFileSync(saPath, JSON.stringify(sa));
      process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
      const creds = resolveLlmCredentials({ provider: 'vertex' });
      expect(creds.vertexProjectId).toBe('env-project');
    });

    it('honors GCP_LOCATION / VERTEX_LOCATION overrides over the us-central1 default', () => {
      const sa = { project_id: 'p', client_email: 'e@e.iam.gserviceaccount.com', private_key: 'PK' };
      fs.writeFileSync(saPath, JSON.stringify(sa));
      process.env.GCP_LOCATION = 'europe-west1';
      const creds = resolveLlmCredentials({ provider: 'vertex', key: saPath });
      expect(creds.vertexLocation).toBe('europe-west1');
    });

    it('accepts a raw OAuth bearer token starting with "ya29." with no service-account JSON', () => {
      process.env.GCP_PROJECT_ID = 'token-project';
      const creds = resolveLlmCredentials({ provider: 'vertex', key: 'ya29.thisIsAFakeBearerToken' });
      expect(creds.vertexSaData).toBeUndefined();
      expect(creds.vertexToken).toBe('ya29.thisIsAFakeBearerToken');
      expect(creds.vertexProjectId).toBe('token-project');
    });

    it('throws when the key is neither valid JSON, an existing file, nor a "ya29." token', () => {
      expect(() => resolveLlmCredentials({ provider: 'vertex', key: 'not-json-not-a-path-not-a-token' })).toThrow(
        /Vertex key must be a valid Service Account JSON file path/
      );
    });

    it('throws when a service-account JSON is present but has no resolvable project id', () => {
      const sa = { client_email: 'e@e.iam.gserviceaccount.com', private_key: 'PK' }; // no project_id
      const creds = () => resolveLlmCredentials({ provider: 'vertex', key: JSON.stringify(sa) });
      expect(creds).toThrow(/Vertex Project ID could not be determined/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('sendPrompt', () => {
  it('gemini: builds the generateContent URL/payload and extracts candidates[0].content.parts[0].text', async () => {
    mockMakeHttpRequest.mockResolvedValue(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] })
    );
    const creds: LlmCredentials = { provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'k1' };
    const result = await sendPrompt(creds, 'sys', 'user');
    expect(result).toBe('{"ok":true}');

    expect(mockMakeHttpRequest).toHaveBeenCalledTimes(1);
    const [url, method, headers, body] = mockMakeHttpRequest.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=k1');
    expect(method).toBe('POST');
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
    const payload = JSON.parse(body);
    expect(payload.contents).toEqual([{ parts: [{ text: 'user' }] }]);
    expect(payload.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
  });

  it('gemini: returns "" when the response has no candidates (malformed/empty shape)', async () => {
    mockMakeHttpRequest.mockResolvedValue(JSON.stringify({}));
    const creds: LlmCredentials = { provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'k1' };
    expect(await sendPrompt(creds, 'sys', 'user')).toBe('');
  });

  it('gemini: malformed JSON body is handled via safeJsonParse without throwing (falls back to "")', async () => {
    mockMakeHttpRequest.mockResolvedValue('not json at all {{{');
    const creds: LlmCredentials = { provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'k1' };
    await expect(sendPrompt(creds, 'sys', 'user')).resolves.toBe('');
  });

  it('vertex: uses a raw vertexToken directly (no getVertexTokenCached call) and builds the aiplatform URL', async () => {
    mockMakeHttpRequest.mockResolvedValue(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'vertex-reply' }] } }] })
    );
    const creds: LlmCredentials = {
      provider: 'vertex',
      model: 'gemini-1.5-flash',
      vertexToken: 'ya29.raw',
      vertexProjectId: 'proj1',
      vertexLocation: 'us-central1',
    };
    const result = await sendPrompt(creds, 'sys', 'user');
    expect(result).toBe('vertex-reply');
    expect(mockGetVertexTokenCached).not.toHaveBeenCalled();

    const [url, , headers] = mockMakeHttpRequest.mock.calls[0];
    expect(url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/proj1/locations/us-central1/publishers/google/models/gemini-1.5-flash:generateContent'
    );
    expect(headers.Authorization).toBe('Bearer ya29.raw');
  });

  it('vertex: falls back to getVertexTokenCached(vertexSaData) when no raw vertexToken is set', async () => {
    mockGetVertexTokenCached.mockResolvedValue('minted-token');
    mockMakeHttpRequest.mockResolvedValue(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    );
    const saData = { project_id: 'proj2', client_email: 'e@e', private_key: 'pk' };
    const creds: LlmCredentials = {
      provider: 'vertex',
      model: 'gemini-1.5-flash',
      vertexSaData: saData,
      vertexProjectId: 'proj2',
      vertexLocation: 'us-central1',
    };
    await sendPrompt(creds, 'sys', 'user');
    expect(mockGetVertexTokenCached).toHaveBeenCalledWith(saData);
    const [, , headers] = mockMakeHttpRequest.mock.calls[0];
    expect(headers.Authorization).toBe('Bearer minted-token');
  });

  it('ollama: posts to {url}/api/chat and extracts message.content, trimming a trailing slash from the base url', async () => {
    mockMakeHttpRequest.mockResolvedValue(JSON.stringify({ message: { content: 'ollama-reply' } }));
    const creds: LlmCredentials = { provider: 'ollama', model: 'qwen2.5-coder', url: 'http://localhost:11434/' };
    const result = await sendPrompt(creds, 'sys', 'user');
    expect(result).toBe('ollama-reply');

    const [url, method, headers, body] = mockMakeHttpRequest.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(method).toBe('POST');
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({
      model: 'qwen2.5-coder',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user' },
      ],
      stream: false,
      format: 'json',
    });
  });

  it('ollama: defaults url to http://localhost:11434 when creds.url is unset', async () => {
    mockMakeHttpRequest.mockResolvedValue(JSON.stringify({ message: { content: 'x' } }));
    const creds: LlmCredentials = { provider: 'ollama', model: 'qwen2.5-coder' };
    await sendPrompt(creds, 'sys', 'user');
    const [url] = mockMakeHttpRequest.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
  });

  it('vertex: returns "" when the response has no candidates (malformed/empty shape)', async () => {
    mockMakeHttpRequest.mockResolvedValue(JSON.stringify({}));
    const creds: LlmCredentials = {
      provider: 'vertex',
      model: 'gemini-1.5-flash',
      vertexToken: 'ya29.raw',
      vertexProjectId: 'proj1',
      vertexLocation: 'us-central1',
    };
    expect(await sendPrompt(creds, 'sys', 'user')).toBe('');
  });

  it('ollama: returns "" when the response has no message field (malformed/empty shape)', async () => {
    mockMakeHttpRequest.mockResolvedValue(JSON.stringify({}));
    const creds: LlmCredentials = { provider: 'ollama', model: 'qwen2.5-coder' };
    expect(await sendPrompt(creds, 'sys', 'user')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendPromptWithRetry
// ─────────────────────────────────────────────────────────────────────────────

describe('sendPromptWithRetry', () => {
  const creds: LlmCredentials = { provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'k1' };

  it('returns immediately on first-attempt success without ever calling sleep', async () => {
    mockMakeHttpRequest.mockResolvedValue(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    const result = await sendPromptWithRetry(creds, 'sys', 'user');
    expect(result).toBe('ok');
    expect(mockMakeHttpRequest).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('a 429 failure triggers backoff starting at 5000ms and doubling on each subsequent 429', async () => {
    mockMakeHttpRequest
      .mockRejectedValueOnce(new Error('Request failed with status 429: rate limited'))
      .mockRejectedValueOnce(new Error('Request failed with status 429: rate limited'))
      .mockResolvedValueOnce(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'finally' }] } }] }));

    const onRetry = jest.fn();
    const result = await sendPromptWithRetry(creds, 'sys', 'user', { retries: 3, onRetry });

    expect(result).toBe('finally');
    expect(mockMakeHttpRequest).toHaveBeenCalledTimes(3);
    // backoff starts at 5000ms and doubles after each rate-limited attempt
    expect(mockSleep.mock.calls.map(c => c[0])).toEqual([5000, 10000]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toMatch(/retrying in 5s/);
    expect(onRetry.mock.calls[1][0]).toMatch(/retrying in 10s/);
  });

  it('a non-429 failure is retried too, but with a flat 2s backoff (not the 429 exponential schedule)', async () => {
    mockMakeHttpRequest
      .mockRejectedValueOnce(new Error('Request failed with status 500: server error'))
      .mockResolvedValueOnce(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok-after-500' }] } }] }));

    const result = await sendPromptWithRetry(creds, 'sys', 'user', { retries: 3 });
    expect(result).toBe('ok-after-500');
    expect(mockSleep).toHaveBeenCalledWith(2000);
  });

  it('exhausts all retries and rethrows the last error when every attempt fails', async () => {
    mockMakeHttpRequest.mockRejectedValue(new Error('Request failed with status 500: still broken'));
    await expect(sendPromptWithRetry(creds, 'sys', 'user', { retries: 2 })).rejects.toThrow('still broken');
    expect(mockMakeHttpRequest).toHaveBeenCalledTimes(2);
    // no sleep after the LAST attempt (nothing left to retry for)
    expect(mockSleep).toHaveBeenCalledTimes(1);
  });

  it('defaults to 3 attempts when opts.retries is omitted', async () => {
    mockMakeHttpRequest.mockRejectedValue(new Error('Request failed with status 500: nope'));
    await expect(sendPromptWithRetry(creds, 'sys', 'user')).rejects.toThrow();
    expect(mockMakeHttpRequest).toHaveBeenCalledTimes(3);
  });

  it('treats a failure with no error message as non-rate-limited (empty-string fallback) and uses the flat 2s backoff message', async () => {
    mockMakeHttpRequest
      .mockRejectedValueOnce(new Error(''))
      .mockResolvedValueOnce(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'recovered' }] } }] }));

    const onRetry = jest.fn();
    const result = await sendPromptWithRetry(creds, 'sys', 'user', { retries: 2, onRetry });

    expect(result).toBe('recovered');
    expect(mockSleep).toHaveBeenCalledWith(2000);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatch(/retrying in 2s/);
  });

  it('throws a fallback error (no attempt ever ran) when opts.retries is 0', async () => {
    await expect(sendPromptWithRetry(creds, 'sys', 'user', { retries: 0 })).rejects.toThrow('sendPrompt failed after retries');
    expect(mockMakeHttpRequest).not.toHaveBeenCalled();
    expect(mockSleep).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendConversationTurn / sendConversationTurnWithRetry — provider dispatch wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('sendConversationTurn', () => {
  const messages: LlmConversationMessage[] = [{ role: 'user', content: 'hello' }];
  const tools: LlmTool[] = [{ name: 'lookup', description: 'looks things up', parameters: { type: 'object', properties: {} } }];

  it('gemini: dispatches to the Generative Language API and parses a functionCall via parseGeminiParts', async () => {
    mockMakeHttpRequest.mockResolvedValue(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'let me check' },
                { functionCall: { name: 'lookup', args: { q: 'foo' } } },
              ],
            },
          },
        ],
      })
    );
    const creds: LlmCredentials = { provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'k1' };
    const result = await sendConversationTurn(creds, 'sys', messages, tools);

    expect(result.text).toBe('let me check');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: 'lookup', args: { q: 'foo' } });
    expect(typeof result.toolCalls[0].id).toBe('string');

    const [url, , , body] = mockMakeHttpRequest.mock.calls[0];
    expect(url).toContain('generativelanguage.googleapis.com');
    const payload = JSON.parse(body);
    expect(payload.tools).toEqual([{ functionDeclarations: [{ name: 'lookup', description: 'looks things up', parameters: tools[0].parameters }] }]);
  });

  it('vertex: resolves a token via getVertexTokenCached and dispatches to the aiplatform API', async () => {
    mockGetVertexTokenCached.mockResolvedValue('tok-abc');
    mockMakeHttpRequest.mockResolvedValue(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'vertex turn' }] } }] })
    );
    const creds: LlmCredentials = {
      provider: 'vertex',
      model: 'gemini-1.5-flash',
      vertexSaData: { project_id: 'p' },
      vertexProjectId: 'p',
      vertexLocation: 'us-central1',
    };
    const result = await sendConversationTurn(creds, 'sys', messages, tools);
    expect(result.text).toBe('vertex turn');
    expect(result.toolCalls).toEqual([]);
    expect(mockGetVertexTokenCached).toHaveBeenCalledWith({ project_id: 'p' });
  });

  it('ollama: dispatches to {url}/api/chat and parses tool_calls via parseOllamaMessage', async () => {
    mockMakeHttpRequest.mockResolvedValue(
      JSON.stringify({
        message: {
          content: null,
          tool_calls: [{ function: { name: 'lookup', arguments: { q: 'bar' } } }],
        },
      })
    );
    const creds: LlmCredentials = { provider: 'ollama', model: 'qwen2.5-coder', url: 'http://localhost:11434' };
    const result = await sendConversationTurn(creds, 'sys', messages, tools);

    expect(result.text).toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: 'lookup', args: { q: 'bar' } });

    const [url, , , body] = mockMakeHttpRequest.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
    const payload = JSON.parse(body);
    expect(payload.tools).toEqual([{ type: 'function', function: { name: 'lookup', description: 'looks things up', parameters: tools[0].parameters } }]);
  });

  it('gemini: returns no text/toolCalls when the response has no candidates (malformed/empty shape)', async () => {
    mockMakeHttpRequest.mockResolvedValue(JSON.stringify({}));
    const creds: LlmCredentials = { provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'k1' };
    const result = await sendConversationTurn(creds, 'sys', messages, tools);
    expect(result).toEqual({ text: null, toolCalls: [] });
  });

  it('vertex: returns no text/toolCalls when the response has no candidates (malformed/empty shape)', async () => {
    mockMakeHttpRequest.mockResolvedValue(JSON.stringify({}));
    const creds: LlmCredentials = {
      provider: 'vertex',
      model: 'gemini-1.5-flash',
      vertexToken: 'ya29.raw',
      vertexProjectId: 'proj1',
      vertexLocation: 'us-central1',
    };
    const result = await sendConversationTurn(creds, 'sys', messages, tools);
    expect(result).toEqual({ text: null, toolCalls: [] });
  });

  it('ollama: returns no text/toolCalls when the response has no message field (malformed/empty shape)', async () => {
    mockMakeHttpRequest.mockResolvedValue(JSON.stringify({}));
    const creds: LlmCredentials = { provider: 'ollama', model: 'qwen2.5-coder', url: 'http://localhost:11434' };
    const result = await sendConversationTurn(creds, 'sys', messages, tools);
    expect(result).toEqual({ text: null, toolCalls: [] });
  });

  it('ollama: defaults url to http://localhost:11434 when creds.url is unset', async () => {
    mockMakeHttpRequest.mockResolvedValue(JSON.stringify({ message: { content: 'hi' } }));
    const creds: LlmCredentials = { provider: 'ollama', model: 'qwen2.5-coder' };
    await sendConversationTurn(creds, 'sys', messages, tools);
    const [url] = mockMakeHttpRequest.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
  });
});

describe('sendConversationTurnWithRetry', () => {
  const messages: LlmConversationMessage[] = [{ role: 'user', content: 'hi' }];
  const tools: LlmTool[] = [];
  const creds: LlmCredentials = { provider: 'ollama', model: 'qwen2.5-coder', url: 'http://localhost:11434' };

  it('retries on 429 with the same exponential backoff schedule as sendPromptWithRetry', async () => {
    mockMakeHttpRequest
      .mockRejectedValueOnce(new Error('Request failed with status 429: slow down'))
      .mockResolvedValueOnce(JSON.stringify({ message: { content: 'done', tool_calls: [] } }));

    const result = await sendConversationTurnWithRetry(creds, 'sys', messages, tools, { retries: 2 });
    expect(result.text).toBe('done');
    expect(mockSleep).toHaveBeenCalledWith(5000);
  });

  it('rethrows the last error once retries are exhausted', async () => {
    mockMakeHttpRequest.mockRejectedValue(new Error('Request failed with status 500: down'));
    await expect(sendConversationTurnWithRetry(creds, 'sys', messages, tools, { retries: 2 })).rejects.toThrow('down');
    expect(mockMakeHttpRequest).toHaveBeenCalledTimes(2);
  });

  it('defaults opts to {} and retries to 3 when called with no options at all', async () => {
    mockMakeHttpRequest.mockRejectedValue(new Error('Request failed with status 500: down'));
    await expect(sendConversationTurnWithRetry(creds, 'sys', messages, tools)).rejects.toThrow();
    expect(mockMakeHttpRequest).toHaveBeenCalledTimes(3);
  });

  it('invokes onRetry with the rate-limited (backoff/1000) message on a 429', async () => {
    mockMakeHttpRequest
      .mockRejectedValueOnce(new Error('Request failed with status 429: slow down'))
      .mockResolvedValueOnce(JSON.stringify({ message: { content: 'done', tool_calls: [] } }));

    const onRetry = jest.fn();
    const result = await sendConversationTurnWithRetry(creds, 'sys', messages, tools, { retries: 2, onRetry });
    expect(result.text).toBe('done');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatch(/retrying in 5s/);
  });

  it('invokes onRetry with the flat 2s message on a non-429 failure with no error message', async () => {
    mockMakeHttpRequest
      .mockRejectedValueOnce(new Error(''))
      .mockResolvedValueOnce(JSON.stringify({ message: { content: 'done', tool_calls: [] } }));

    const onRetry = jest.fn();
    const result = await sendConversationTurnWithRetry(creds, 'sys', messages, tools, { retries: 2, onRetry });
    expect(result.text).toBe('done');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatch(/retrying in 2s/);
  });

  it('throws a fallback error (no attempt ever ran) when opts.retries is 0', async () => {
    await expect(sendConversationTurnWithRetry(creds, 'sys', messages, tools, { retries: 0 })).rejects.toThrow(
      'sendConversationTurn failed after retries'
    );
    expect(mockMakeHttpRequest).not.toHaveBeenCalled();
  });
});
