import { clusterGraphFeedback, GraphFeedbackEntry } from '../../src/db/feedback';
import { deriveStatus, MessageEdit } from '../../src/db/activity';
import { reconstructBeforeFile } from '../../src/db/file-diff';
import { deriveTitleFromMarkdown } from '../../src/db/workflow-import';
import { summarizeEntriesForWorkflow, StagedEntry } from '../../src/db/staging';
import { createMissingCollector } from '../../src/db/edges';
import { resolveRepoPath, canonicalizePath, ProjectContext, DevMindConfig } from '../../src/utils/config';
import { MissingRef } from '../../src/utils/ast';
import { ReasoningObject } from '../../src/db/database';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────
// feedback.ts — clusterGraphFeedback
// ─────────────────────────────────────────────────────────────────────────
describe('clusterGraphFeedback', () => {
  function entry(overrides: Partial<GraphFeedbackEntry>): GraphFeedbackEntry {
    return {
      id: overrides.id || Math.random().toString(36),
      ts: '2026-01-01T00:00:00.000Z',
      session_id: 's1',
      category: 'graph_problem',
      text: 'something is wrong',
      confidence: 'suspected',
      ...overrides
    };
  }

  it('returns [] for no entries', () => {
    expect(clusterGraphFeedback([])).toEqual([]);
  });

  it('groups entries by (node_id, category)', () => {
    const entries = [
      entry({ node_id: 'n1', category: 'graph_problem' }),
      entry({ node_id: 'n1', category: 'graph_problem' }),
      entry({ node_id: 'n1', category: 'edge_problem' }),
      entry({ node_id: 'n2', category: 'graph_problem' })
    ];
    const clusters = clusterGraphFeedback(entries);
    expect(clusters.length).toBe(3);
    const n1Graph = clusters.find(c => c.node_id === 'n1' && c.category === 'graph_problem');
    expect(n1Graph?.count).toBe(2);
  });

  it('sorts clusters by descending frequency', () => {
    const entries = [
      entry({ node_id: 'a', category: 'graph_problem' }),
      entry({ node_id: 'b', category: 'graph_problem' }),
      entry({ node_id: 'b', category: 'graph_problem' }),
      entry({ node_id: 'b', category: 'graph_problem' })
    ];
    const clusters = clusterGraphFeedback(entries);
    expect(clusters[0].node_id).toBe('b');
    expect(clusters[0].count).toBe(3);
    expect(clusters[1].node_id).toBe('a');
  });

  it('groups entries with an undefined node_id under "unknown"', () => {
    const entries = [entry({ node_id: undefined, category: 'edge_problem' })];
    const clusters = clusterGraphFeedback(entries);
    expect(clusters[0].node_id).toBe('unknown');
  });

  it('marks a cluster "confirmed" if ANY entry in it is confirmed', () => {
    const entries = [
      entry({ node_id: 'n1', category: 'graph_problem', confidence: 'suspected' }),
      entry({ node_id: 'n1', category: 'graph_problem', confidence: 'confirmed' })
    ];
    const clusters = clusterGraphFeedback(entries);
    expect(clusters[0].confidence).toBe('confirmed');
  });

  it('marks a cluster "suspected" when every entry is suspected', () => {
    const entries = [
      entry({ node_id: 'n1', category: 'graph_problem', confidence: 'suspected' }),
      entry({ node_id: 'n1', category: 'graph_problem', confidence: 'suspected' })
    ];
    const clusters = clusterGraphFeedback(entries);
    expect(clusters[0].confidence).toBe('suspected');
  });

  it('preserves all original entries within a cluster', () => {
    const e1 = entry({ id: 'e1', node_id: 'n1', category: 'graph_problem' });
    const e2 = entry({ id: 'e2', node_id: 'n1', category: 'graph_problem' });
    const clusters = clusterGraphFeedback([e1, e2]);
    expect(clusters[0].entries).toEqual([e1, e2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// activity.ts — deriveStatus
// ─────────────────────────────────────────────────────────────────────────
describe('deriveStatus', () => {
  function edit(reverted?: boolean): MessageEdit {
    return { id: 'e', node_id: 'n', file_path: 'f.ts', at: '2026-01-01', before: 'a', after: 'b', reverted };
  }

  it('returns "applied" for an empty edits array', () => {
    expect(deriveStatus([])).toBe('applied');
  });

  it('returns "applied" when no edit is reverted', () => {
    expect(deriveStatus([edit(false), edit(undefined)])).toBe('applied');
  });

  it('returns "reverted" when every edit is reverted', () => {
    expect(deriveStatus([edit(true), edit(true)])).toBe('reverted');
  });

  it('returns "partial" when some but not all edits are reverted', () => {
    expect(deriveStatus([edit(true), edit(false)])).toBe('partial');
  });

  it('treats a single reverted edit as fully "reverted"', () => {
    expect(deriveStatus([edit(true)])).toBe('reverted');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// file-diff.ts — reconstructBeforeFile
// ─────────────────────────────────────────────────────────────────────────
describe('reconstructBeforeFile', () => {
  function edit(before: string, after: string): MessageEdit {
    return { id: Math.random().toString(36), node_id: 'n', file_path: 'f.ts', at: '2026-01-01', before, after };
  }

  it('returns the live content unchanged with drifted=false when there are no edits', () => {
    const result = reconstructBeforeFile('const x = 1;', []);
    expect(result).toEqual({ before: 'const x = 1;', drifted: false });
  });

  it('undoes a single edit (after -> before)', () => {
    const live = 'function foo() { return 2; }';
    const edits = [edit('function foo() { return 1; }', 'function foo() { return 2; }')];
    const result = reconstructBeforeFile(live, edits);
    expect(result).toEqual({ before: 'function foo() { return 1; }', drifted: false });
  });

  it('undoes multiple edits to the same file, newest-first', () => {
    // chronological (oldest-first) order, as stored on ActivityMessage.edits
    const edits = [
      edit('const x = 0;', 'const x = 1;'),
      edit('const x = 1;', 'const x = 2;')
    ];
    const live = 'const x = 2;';
    const result = reconstructBeforeFile(live, edits);
    expect(result).toEqual({ before: 'const x = 0;', drifted: false });
  });

  it('reports drift when the newest edit\'s "after" is not found in the live content', () => {
    const edits = [edit('const x = 0;', 'const x = 1;')];
    const live = 'const x = 999; // hand-edited since';
    const result = reconstructBeforeFile(live, edits);
    expect(result.drifted).toBe(true);
    expect(result.before).toBe(live);
  });

  it('treats a no-op edit (before === after) as a pass-through, not drift', () => {
    const edits = [edit('same text', 'same text')];
    const result = reconstructBeforeFile('same text', edits);
    expect(result).toEqual({ before: 'same text', drifted: false });
  });

  it('reports drift when "after" is empty (no anchor to locate)', () => {
    const edits = [edit('before-text', '')];
    const result = reconstructBeforeFile('live content', edits);
    expect(result.drifted).toBe(true);
  });

  it('reports drift when "after" appears more than once in the content (ambiguous undo)', () => {
    const edits = [edit('X', 'dup')];
    const live = 'dup dup';
    const result = reconstructBeforeFile(live, edits);
    expect(result.drifted).toBe(true);
  });

  it('stops undoing at the first edit that fails to apply, even if earlier edits would have matched', () => {
    const edits = [
      edit('const x = 0;', 'const x = 1;'), // oldest
      edit('const x = 1;', 'const x = 2;')  // newest — applied first when undoing
    ];
    // live content does NOT contain "const x = 2;" so the newest edit's undo fails immediately
    const live = 'const x = 999;';
    const result = reconstructBeforeFile(live, edits);
    expect(result.drifted).toBe(true);
    expect(result.before).toBe(live);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// workflow-import.ts — deriveTitleFromMarkdown
// ─────────────────────────────────────────────────────────────────────────
describe('deriveTitleFromMarkdown', () => {
  it('derives name from an H1 title and description from a Summary section', () => {
    const content = '# User Login Flow\n\n## Summary\n\nHandles authenticating a user against stored credentials.\n\n## Steps\n\n1. Do a thing.';
    const result = deriveTitleFromMarkdown(content, 'login-flow.md');
    expect(result.name).toBe('User Login Flow');
    expect(result.description).toBe('Handles authenticating a user against stored credentials.');
  });

  it('strips a trailing parenthetical from the title', () => {
    const content = '# User Login Flow (draft)\n';
    const result = deriveTitleFromMarkdown(content, 'x.md');
    expect(result.name).toBe('User Login Flow');
  });

  it('falls back to a cleaned-up filename when there is no H1 title', () => {
    const content = 'No heading here, just prose.';
    const result = deriveTitleFromMarkdown(content, 'user-login-flow.md');
    expect(result.name).toBe('User Login');
  });

  it('falls back to the first paragraph after the title when there is no Summary section', () => {
    const content = '# My Flow\n\nThis is the first paragraph describing the flow.\n\nSecond paragraph.';
    const result = deriveTitleFromMarkdown(content, 'x.md');
    expect(result.description).toBe('This is the first paragraph describing the flow.');
  });

  it('falls back to "Imported from <file>" when there is neither a Summary nor a usable paragraph', () => {
    const content = '# Only A Title\n';
    const result = deriveTitleFromMarkdown(content, 'weird.md');
    expect(result.description).toBe('Imported from weird.md');
  });

  it('uses only the first paragraph of a multi-paragraph Summary section', () => {
    const content = '# T\n\n## Summary\n\nFirst para.\n\nSecond para.\n\n## Next\n';
    const result = deriveTitleFromMarkdown(content, 'x.md');
    expect(result.description).toBe('First para.');
  });

  it('falls back to the filename itself when name ends up empty', () => {
    // filename with only symbols stripped by the cleanup regex ends up empty
    const result = deriveTitleFromMarkdown('no title', '---.md');
    expect(result.name).toBe('---.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// staging.ts — summarizeEntriesForWorkflow
// ─────────────────────────────────────────────────────────────────────────
describe('summarizeEntriesForWorkflow', () => {
  function stagedEntry(node_id: string): StagedEntry {
    return { node_id, file_path: 'f.ts', code_snapshot: 'code' };
  }

  it('uses reasoning.what_changed when present on an object reasoning', () => {
    const reasoning: ReasoningObject = {
      what_changed: 'Refactored auth flow',
      why: 'why',
      goal: 'goal'
    } as ReasoningObject;
    const result = summarizeEntriesForWorkflow([stagedEntry('n1')], reasoning);
    expect(result).toBe('Refactored auth flow');
  });

  it('names the single staged entity for a bare-string reasoning with one entry', () => {
    const result = summarizeEntriesForWorkflow([stagedEntry('n1')], 'just a string reason');
    expect(result).toBe('n1');
  });

  it('summarizes multiple entities with a count for a bare-string reasoning', () => {
    const result = summarizeEntriesForWorkflow([stagedEntry('n1'), stagedEntry('n2')], 'reason');
    expect(result).toBe('2 entities updated: n1; n2');
  });

  it('falls back to naming entities when reasoning is an object with no what_changed', () => {
    const reasoning = { why: 'why', goal: 'goal' } as unknown as ReasoningObject;
    const result = summarizeEntriesForWorkflow([stagedEntry('n1')], reasoning);
    expect(result).toBe('n1');
  });

  it('handles an empty entries array with a bare-string reasoning', () => {
    const result = summarizeEntriesForWorkflow([], 'reason');
    expect(result).toBe('0 entities updated: ');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// edges.ts — createMissingCollector
// ─────────────────────────────────────────────────────────────────────────
describe('createMissingCollector', () => {
  function ref(overrides: Partial<MissingRef>): MissingRef {
    return { sourceNodeId: 'src', name: 'symbol', targetFile: 'file.ts', ...overrides };
  }

  it('starts with an empty map', () => {
    const { missing } = createMissingCollector();
    expect(missing.size).toBe(0);
  });

  it('records a single missing reference', () => {
    const { missing, onMissing } = createMissingCollector();
    onMissing(ref({ sourceNodeId: 'a', targetFile: 'x.ts', name: 'foo' }));
    expect(missing.size).toBe(1);
    const entry = [...missing.values()][0];
    expect(entry.file).toBe('x.ts');
    expect(entry.symbol).toBe('foo');
    expect([...entry.referenced_by]).toEqual(['a']);
  });

  it('dedupes by (targetFile, name), aggregating referenced_by', () => {
    const { missing, onMissing } = createMissingCollector();
    onMissing(ref({ sourceNodeId: 'a', targetFile: 'x.ts', name: 'foo' }));
    onMissing(ref({ sourceNodeId: 'b', targetFile: 'x.ts', name: 'foo' }));
    expect(missing.size).toBe(1);
    const entry = [...missing.values()][0];
    expect([...entry.referenced_by].sort()).toEqual(['a', 'b']);
  });

  it('does not duplicate the same source referencing the same missing symbol twice', () => {
    const { missing, onMissing } = createMissingCollector();
    onMissing(ref({ sourceNodeId: 'a', targetFile: 'x.ts', name: 'foo' }));
    onMissing(ref({ sourceNodeId: 'a', targetFile: 'x.ts', name: 'foo' }));
    const entry = [...missing.values()][0];
    expect(entry.referenced_by.size).toBe(1);
  });

  it('treats different targetFile/name combinations as separate entries', () => {
    const { missing, onMissing } = createMissingCollector();
    onMissing(ref({ targetFile: 'x.ts', name: 'foo' }));
    onMissing(ref({ targetFile: 'y.ts', name: 'foo' }));
    onMissing(ref({ targetFile: 'x.ts', name: 'bar' }));
    expect(missing.size).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// config.ts — resolveRepoPath, canonicalizePath
// ─────────────────────────────────────────────────────────────────────────
describe('resolveRepoPath', () => {
  function ctx(config: DevMindConfig, env: Record<string, string> = {}): ProjectContext {
    return { devmind_path: 'C:/proj/.devmind', config, env };
  }

  it('resolves an embedded-mode repo relative to the parent of devmind_path', () => {
    const context = ctx({
      project_name: 'p', mode: 'embedded',
      repos: [{ name: 'backend', relative_path: 'services/backend' }]
    });
    const result = resolveRepoPath(context, 'backend');
    expect(result).toBe(path.resolve('C:/proj', 'services/backend'));
  });

  it('returns null for embedded mode when the repo has no relative_path', () => {
    const context = ctx({
      project_name: 'p', mode: 'embedded',
      repos: [{ name: 'backend' } as any]
    });
    expect(resolveRepoPath(context, 'backend')).toBeNull();
  });

  it('resolves a standalone-mode repo via env lookup by path_key', () => {
    const context = ctx(
      { project_name: 'p', mode: 'standalone', repos: [{ name: 'backend', path_key: 'BACKEND_PATH' }] },
      { BACKEND_PATH: 'D:/code/backend' }
    );
    const result = resolveRepoPath(context, 'backend');
    expect(result).toBe(path.resolve('D:/code/backend'));
  });

  it('returns null for standalone mode when the env var is not set', () => {
    const context = ctx(
      { project_name: 'p', mode: 'standalone', repos: [{ name: 'backend', path_key: 'MISSING_KEY' }] },
      {}
    );
    expect(resolveRepoPath(context, 'backend')).toBeNull();
  });

  it('returns null for standalone mode when the repo has no path_key', () => {
    const context = ctx(
      { project_name: 'p', mode: 'standalone', repos: [{ name: 'backend' } as any] },
      {}
    );
    expect(resolveRepoPath(context, 'backend')).toBeNull();
  });

  it('returns null when the repo name is not found at all', () => {
    const context = ctx({ project_name: 'p', mode: 'embedded', repos: [] });
    expect(resolveRepoPath(context, 'nonexistent')).toBeNull();
  });
});

describe('canonicalizePath', () => {
  it('returns falsy input unchanged (empty string)', () => {
    expect(canonicalizePath('')).toBe('');
  });

  it('resolves a relative path to an absolute one', () => {
    const result = canonicalizePath('some/relative/path');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('lowercases the drive letter on win32', () => {
    if (process.platform === 'win32') {
      const result = canonicalizePath('D:\\Code\\Project');
      expect(result[0]).toBe('d');
      expect(result[1]).toBe(':');
    }
  });

  it('leaves an already-lowercase drive letter unchanged in form', () => {
    if (process.platform === 'win32') {
      const upper = canonicalizePath('E:\\x');
      const lower = canonicalizePath('e:\\x');
      expect(upper).toBe(lower);
    }
  });
});
