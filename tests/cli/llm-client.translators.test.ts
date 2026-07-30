import {
  buildGeminiContents,
  buildGeminiTools,
  parseGeminiParts,
  buildOllamaMessages,
  buildOllamaTools,
  parseOllamaMessage,
  LlmTool,
  LlmToolCall,
  LlmConversationMessage
} from '../../src/cli/llm-client';

const sampleTools: LlmTool[] = [
  {
    name: 'search_nodes',
    description: 'Search the graph for nodes matching a query.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  {
    name: 'get_node',
    description: 'Fetch a single node by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  }
];

// A realistic conversation: system prompt (passed separately), user message, an assistant turn
// that calls a tool, then the tool's result coming back.
function sampleConversation(): LlmConversationMessage[] {
  const toolCall: LlmToolCall = { id: 'call-1', name: 'search_nodes', args: { query: 'login' } };
  return [
    { role: 'user', content: 'Where is login handled?' },
    { role: 'assistant', content: 'Let me check.', toolCalls: [toolCall] },
    { role: 'tool', toolCallId: 'call-1', toolName: 'search_nodes', content: JSON.stringify({ results: ['{repo}/auth.ts#login'] }) }
  ];
}

describe('buildGeminiContents', () => {
  it('maps a user message to role "user" with a text part', () => {
    const contents = buildGeminiContents([{ role: 'user', content: 'hello' }]) as any[];
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
  });

  it('maps an assistant message with only text (no tool calls) to role "model"', () => {
    const contents = buildGeminiContents([{ role: 'assistant', content: 'sure thing', toolCalls: [] }]) as any[];
    expect(contents).toEqual([{ role: 'model', parts: [{ text: 'sure thing' }] }]);
  });

  it('maps an assistant message with tool calls to functionCall parts', () => {
    const toolCall: LlmToolCall = { id: 'c1', name: 'search_nodes', args: { query: 'login' } };
    const contents = buildGeminiContents([{ role: 'assistant', content: null, toolCalls: [toolCall] }]) as any[];
    expect(contents).toEqual([{ role: 'model', parts: [{ functionCall: { name: 'search_nodes', args: { query: 'login' } } }] }]);
  });

  it('maps an assistant message with BOTH narration text and a tool call to two parts', () => {
    const toolCall: LlmToolCall = { id: 'c1', name: 'search_nodes', args: { query: 'login' } };
    const contents = buildGeminiContents([{ role: 'assistant', content: 'Checking now.', toolCalls: [toolCall] }]) as any[];
    expect(contents).toEqual([{
      role: 'model',
      parts: [{ text: 'Checking now.' }, { functionCall: { name: 'search_nodes', args: { query: 'login' } } }]
    }]);
  });

  it('omits the text part when assistant content is null', () => {
    const contents = buildGeminiContents([{ role: 'assistant', content: null, toolCalls: [] }]) as any[];
    expect(contents).toEqual([{ role: 'model', parts: [] }]);
  });

  it('maps a tool-result message to a user-role functionResponse matched by NAME, parsing JSON content', () => {
    const contents = buildGeminiContents([
      { role: 'tool', toolCallId: 'c1', toolName: 'search_nodes', content: JSON.stringify({ ok: true }) }
    ]) as any[];
    expect(contents).toEqual([{ role: 'user', parts: [{ functionResponse: { name: 'search_nodes', response: { ok: true } } }] }]);
  });

  it('falls back to a {result: content} wrapper when tool content is not valid JSON', () => {
    const contents = buildGeminiContents([
      { role: 'tool', toolCallId: 'c1', toolName: 'search_nodes', content: 'not json' }
    ]) as any[];
    expect(contents).toEqual([{ role: 'user', parts: [{ functionResponse: { name: 'search_nodes', response: { result: 'not json' } } }] }]);
  });

  it('translates a full round-trip conversation in order', () => {
    const contents = buildGeminiContents(sampleConversation()) as any[];
    expect(contents.length).toBe(3);
    expect(contents[0].role).toBe('user');
    expect(contents[1].role).toBe('model');
    expect(contents[1].parts[1].functionCall.name).toBe('search_nodes');
    expect(contents[2].role).toBe('user');
    expect(contents[2].parts[0].functionResponse.name).toBe('search_nodes');
  });

  it('handles an empty message list', () => {
    expect(buildGeminiContents([])).toEqual([]);
  });
});

describe('buildGeminiTools', () => {
  it('wraps tools in a single functionDeclarations entry', () => {
    const tools = buildGeminiTools(sampleTools) as any[];
    expect(tools).toEqual([{
      functionDeclarations: [
        { name: 'search_nodes', description: 'Search the graph for nodes matching a query.', parameters: sampleTools[0].parameters },
        { name: 'get_node', description: 'Fetch a single node by id.', parameters: sampleTools[1].parameters }
      ]
    }]);
  });

  it('handles an empty tools array', () => {
    expect(buildGeminiTools([])).toEqual([{ functionDeclarations: [] }]);
  });
});

describe('parseGeminiParts', () => {
  it('accumulates text across multiple text parts', () => {
    const result = parseGeminiParts([{ text: 'Hello ' }, { text: 'world' }]);
    expect(result.text).toBe('Hello world');
    expect(result.toolCalls).toEqual([]);
  });

  it('returns text=null when there are no text parts', () => {
    const result = parseGeminiParts([{ functionCall: { name: 'search_nodes', args: { query: 'x' } } }]);
    expect(result.text).toBeNull();
  });

  it('parses a functionCall part into a tool call with args defaulting to {} when absent', () => {
    const result = parseGeminiParts([{ functionCall: { name: 'get_node' } }]);
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].name).toBe('get_node');
    expect(result.toolCalls[0].args).toEqual({});
    expect(typeof result.toolCalls[0].id).toBe('string');
    expect(result.toolCalls[0].id.length).toBeGreaterThan(0);
  });

  it('mints a distinct id per tool call', () => {
    const result = parseGeminiParts([
      { functionCall: { name: 'a' } },
      { functionCall: { name: 'b' } }
    ]);
    expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id);
  });

  it('handles both text and function-call parts together', () => {
    const result = parseGeminiParts([
      { text: 'Checking now.' },
      { functionCall: { name: 'search_nodes', args: { query: 'login' } } }
    ]);
    expect(result.text).toBe('Checking now.');
    expect(result.toolCalls).toEqual([{ id: expect.any(String), name: 'search_nodes', args: { query: 'login' } }]);
  });

  it('handles an empty/undefined parts array', () => {
    expect(parseGeminiParts([])).toEqual({ text: null, toolCalls: [] });
    // @ts-expect-error - exercising the `parts || []` fallback for a falsy input
    expect(parseGeminiParts(undefined)).toEqual({ text: null, toolCalls: [] });
  });

  it('ignores a part with neither text nor functionCall', () => {
    const result = parseGeminiParts([{}]);
    expect(result).toEqual({ text: null, toolCalls: [] });
  });
});

describe('buildOllamaMessages', () => {
  it('always leads with a system message', () => {
    const messages = buildOllamaMessages('You are a helpful agent.', []) as any[];
    expect(messages).toEqual([{ role: 'system', content: 'You are a helpful agent.' }]);
  });

  it('maps a user message straight through', () => {
    const messages = buildOllamaMessages('sys', [{ role: 'user', content: 'hi' }]) as any[];
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('maps an assistant message, defaulting content to "" when null, and translating tool calls', () => {
    const toolCall: LlmToolCall = { id: 'c1', name: 'search_nodes', args: { query: 'login' } };
    const messages = buildOllamaMessages('sys', [{ role: 'assistant', content: null, toolCalls: [toolCall] }]) as any[];
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'search_nodes', arguments: { query: 'login' } } }]
    });
  });

  it('maps an assistant message with text content unchanged', () => {
    const messages = buildOllamaMessages('sys', [{ role: 'assistant', content: 'ok', toolCalls: [] }]) as any[];
    expect(messages[1]).toEqual({ role: 'assistant', content: 'ok', tool_calls: [] });
  });

  it('maps a tool-result message using tool_name to correlate (no call-id field)', () => {
    const messages = buildOllamaMessages('sys', [
      { role: 'tool', toolCallId: 'c1', toolName: 'search_nodes', content: '{"ok":true}' }
    ]) as any[];
    expect(messages[1]).toEqual({ role: 'tool', tool_name: 'search_nodes', content: '{"ok":true}' });
  });

  it('translates a full round-trip conversation in order after the system message', () => {
    const messages = buildOllamaMessages('sys', sampleConversation()) as any[];
    expect(messages.length).toBe(4);
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(messages[1].role).toBe('user');
    expect(messages[2].role).toBe('assistant');
    expect(messages[2].tool_calls[0].function.name).toBe('search_nodes');
    expect(messages[3]).toEqual({ role: 'tool', tool_name: 'search_nodes', content: expect.any(String) });
  });
});

describe('buildOllamaTools', () => {
  it('maps tools to OpenAI-style {type:"function", function:{...}} entries', () => {
    const tools = buildOllamaTools(sampleTools) as any[];
    expect(tools).toEqual([
      { type: 'function', function: { name: 'search_nodes', description: 'Search the graph for nodes matching a query.', parameters: sampleTools[0].parameters } },
      { type: 'function', function: { name: 'get_node', description: 'Fetch a single node by id.', parameters: sampleTools[1].parameters } }
    ]);
  });

  it('handles an empty tools array', () => {
    expect(buildOllamaTools([])).toEqual([]);
  });
});

describe('parseOllamaMessage', () => {
  it('returns text=null when content is absent', () => {
    const result = parseOllamaMessage({});
    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([]);
  });

  it('passes through message content as text', () => {
    const result = parseOllamaMessage({ content: 'hello there' });
    expect(result.text).toBe('hello there');
  });

  it('parses tool_calls into LlmToolCall entries with args defaulting to {}', () => {
    const result = parseOllamaMessage({
      tool_calls: [{ function: { name: 'search_nodes' } }]
    });
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].name).toBe('search_nodes');
    expect(result.toolCalls[0].args).toEqual({});
    expect(typeof result.toolCalls[0].id).toBe('string');
  });

  it('passes through explicit arguments unchanged', () => {
    const result = parseOllamaMessage({
      tool_calls: [{ function: { name: 'get_node', arguments: { id: 'n1' } } }]
    });
    expect(result.toolCalls[0].args).toEqual({ id: 'n1' });
  });

  it('filters out tool_calls entries with no function name', () => {
    const result = parseOllamaMessage({
      tool_calls: [{ function: { name: '' } }, { }, { function: { name: 'get_node' } }]
    });
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].name).toBe('get_node');
  });

  it('handles multiple tool calls, minting distinct ids', () => {
    const result = parseOllamaMessage({
      tool_calls: [{ function: { name: 'a' } }, { function: { name: 'b' } }]
    });
    expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id);
  });
});
