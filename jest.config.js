/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // 45s, not the default 5s or the previous 20s: several tests do real, load-sensitive I/O — a
  // git subprocess per call (tests/db/analyze.test.ts, 36 call sites) or a full MCP round-trip
  // through a fresh client (tests/mcp/tools.test.ts) — and two different ones from those two
  // categories were each observed exceeding 20s only when running inside the full ~1350-test
  // coverage suite under load, while finishing in 3-5s in isolation every time. Raised globally
  // rather than per-test, since more tests in the same two files are one unlucky run away from
  // the identical flake.
  testTimeout: 45000,
  // Capped because the contention is real and specific, not general slowness: 17 of these suites
  // reach code that loads the 23MB ONNX embedding model, the session is cached per PROCESS, and
  // Jest gives every suite its own worker — so an uncapped run has seventeen workers pulling the
  // same 23MB off one disk at once. Left alone, `tests/db/search.test.ts` (3.5s on its own) blew
  // a 60-SECOND beforeAll hook during an `npm publish`, failing all 19 of its tests without
  // running one of them and taking the release with it.
  //
  // Four rather than "half the cores": the ceiling here is disk throughput, not CPU, so scaling
  // with core count would keep the same starvation on a machine with more of them. The cost is
  // wall-clock on an idle machine, which is the right thing to trade for a suite that does not
  // fail because something else happened to be running.
  maxWorkers: 4,
  collectCoverage: false,
  collectCoverageFrom: [
    'src/utils/tokenize.ts',
    'src/utils/json.ts',
    'src/utils/diff.ts',
    'src/utils/edit.ts',
    'src/utils/config.ts',
    'src/utils/scanner.ts',
    'src/utils/git.ts',
    'src/utils/ast.ts',
    'src/db/search-index.ts',
    'src/db/feedback.ts',
    'src/db/staging.ts',
    'src/db/edges.ts',
    'src/db/index-build.ts',
    'src/db/indexer.ts',
    'src/db/activity.ts',
    'src/db/file-diff.ts',
    'src/db/revert.ts',
    'src/db/message-revert.ts',
    'src/db/workflow-import.ts',
    'src/db/analyze.ts',
    'src/db/embedder.ts',
    'src/db/schema.ts',
    'src/db/database.ts',
    'src/cli/llm-client.ts',
    'src/cli/integrations/prompt.ts',
    'src/cli/integrations/registry.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'text-summary', 'html', 'lcov'],
  // Regression gate for the core set (collectCoverageFrom above). LINES are held at 100% — that
  // is the metric worth being absolute about, since an uncovered line is code no test has ever
  // run. The other three sit a hair under their achieved numbers so an incidental dip fails
  // loudly without the gate breaking on a harmless refactor.
  //
  // The residual gaps are all branch-level, on compound boolean expressions where existing tests
  // exercise one arm and istanbul still flags the other (all of them in src/db/database.ts, and
  // at least one — parseReasoningBlocksTimed's `parseReasoningBlocks(text)[0] || fallback` — is
  // provably unreachable, since the [0] is guaranteed present for the non-empty text it is handed).
  // They are understood and accepted as the practical ceiling rather than
  // chased with tests that assert nothing real. Specific line numbers are deliberately not listed
  // here — they went stale within one release last time; run `npx jest --coverage` for current ones.
  //
  // src/cli/integrations/prompt.ts and registry.ts joined the set in 3.0.0. They are the code that
  // edits files the DEVELOPER owns (a Cursor rules file, ~/.codex/config.toml, MEMORY.md), where a
  // bug does not fail — it mangles a config and looks like success. That is exactly the shape of
  // defect a coverage gate is for, and one such bug shipped undetected before they were added.
  coverageThreshold: {
    global: {
      statements: 99.9,
      branches: 99.5,
      functions: 99.5,
      lines: 100,
    },
  },
};
