/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 20000,
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
