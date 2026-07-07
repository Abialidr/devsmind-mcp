const { repairJson, extractJsonBlock, safeJsonParse } = require('../dist/utils/json');

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    console.error(`❌ FAIL: ${message}`);
    console.error(`  Expected: ${JSON.stringify(expected)}`);
    console.error(`  Actual:   ${JSON.stringify(actual)}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

console.log('--- Testing extractJsonBlock ---');
assertEqual(
  extractJsonBlock('Some text before {"a": 1} some text after'),
  '{"a": 1}',
  'Extract JSON object from text'
);

assertEqual(
  extractJsonBlock('```json\n{"a": 1}\n```'),
  '{"a": 1}',
  'Extract JSON from markdown block'
);

assertEqual(
  extractJsonBlock('Truncated {"a": "hello'),
  '{"a": "hello',
  'Extract truncated JSON block'
);

console.log('\n--- Testing repairJson ---');
assertEqual(
  repairJson('{"a": 1'),
  '{"a": 1}',
  'Repair missing closing brace'
);

assertEqual(
  repairJson('{"a": "hello'),
  '{"a": "hello"}',
  'Repair unclosed string and brace'
);

assertEqual(
  repairJson('{"nodes": [{"id": "foo", "code": "function hello() {\\'),
  '{"nodes": [{"id": "foo", "code": "function hello() {"}]}',
  'Repair unclosed escape backslash inside string and nested array/object'
);

assertEqual(
  repairJson('{"nodes": [{"id": "foo", "code": "function hello() {\\\\'),
  '{"nodes": [{"id": "foo", "code": "function hello() {\\\\"}]}',
  'Repair escaped backslash inside string and nested structures'
);

console.log('\n--- Testing safeJsonParse ---');
const parsedOk = safeJsonParse('Some text {"nodes": [{"id": "1", "code": "func("', { nodes: [] });
assertEqual(parsedOk.nodes[0].id, '1', 'Safe parse truncated structure ID');
assertEqual(parsedOk.nodes[0].code, 'func(', 'Safe parse truncated structure code');

const parsedFail = safeJsonParse('totally bad string', { fallback: true });
assertEqual(parsedFail.fallback, true, 'Safe parse handles complete garbage gracefully');

console.log('\n🎉 ALL TESTS PASSED!');
