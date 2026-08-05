import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createSession,
  readSessions,
  recordMessage,
  saveMessage,
  readMessage,
  listMessages,
  queryActivityLog,
  bindSessionWorkflow,
  readSessionWorkflow,
  lastBoundWorkflowId,
  ActivityMessage,
  MessageEdit
} from '../../src/db/activity';

// `import * as fs` (under esModuleInterop) produces a non-configurable namespace wrapper that
// jest.spyOn cannot redefine. A plain `require('fs')` returns the real, mutable Node module
// object — the same singleton the source files' `fs.xxx` getters proxy back to — so spying here
// still intercepts calls made from src/db/activity.ts.
const fsReal: typeof fs = require('fs');

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-activity-test-'));
}

function mkEdit(overrides: Partial<MessageEdit> = {}): MessageEdit {
  return {
    id: overrides.id || `edit-${Math.random().toString(36).slice(2)}`,
    node_id: overrides.node_id ?? '{app}/foo.ts#greet',
    file_path: overrides.file_path ?? '/repo/foo.ts',
    at: overrides.at ?? new Date().toISOString(),
    before: overrides.before ?? 'before',
    after: overrides.after ?? 'after'
  };
}

describe('createSession', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('creates a new session and persists it', () => {
    const session = createSession(dir, 'sess-1', 'ada', 'My session');
    expect(session.id).toBe('sess-1');
    expect(session.developer).toBe('ada');
    expect(session.label).toBe('My session');
    expect(session.message_ids).toEqual([]);
    expect(readSessions(dir)).toEqual([session]);
  });

  it('creates a session without a label when none is given', () => {
    const session = createSession(dir, 'sess-2', null);
    expect(session.label).toBeUndefined();
  });

  it('is idempotent: calling twice with the same session_id does not duplicate or clobber it', () => {
    const first = createSession(dir, 'sess-1', 'ada');
    const second = createSession(dir, 'sess-1', 'someone-else', 'ignored label');
    expect(second).toEqual(first); // returns the existing session untouched
    expect(readSessions(dir)).toHaveLength(1);
  });
});

describe('recordMessage', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('creates a new message when there is nothing to continue', () => {
    const msg = recordMessage(dir, {
      session_id: 'sess-1', developer: 'ada', request: 'add greet', summary: 'added greet',
      edits: [mkEdit()]
    });
    expect(msg.session_id).toBe('sess-1');
    expect(msg.status).toBe('applied');
    expect(msg.edits).toHaveLength(1);
    expect(msg.edits[0].id).toBeTruthy();
    expect(readMessage(dir, msg.id)).toEqual(msg);

    const sessions = readSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].message_ids).toEqual([msg.id]);
    expect(sessions[0].developer).toBe('ada');
  });

  it('mints an edit id when the caller did not supply one', () => {
    const editNoId = { node_id: 'x', file_path: 'f', at: 'now', before: 'a', after: 'b' } as MessageEdit;
    const msg = recordMessage(dir, { session_id: 's', developer: null, summary: 'x', edits: [editNoId] });
    expect(msg.edits[0].id).toBeTruthy();
  });

  it("continues the session's newest message when the request text matches", () => {
    const first = recordMessage(dir, {
      session_id: 'sess-1', developer: 'ada', request: 'add greet', summary: 'step 1', edits: [mkEdit()]
    });
    const second = recordMessage(dir, {
      session_id: 'sess-1', developer: 'ada', request: 'add greet', summary: 'step 2', edits: [mkEdit()]
    });
    expect(second.id).toBe(first.id);
    expect(second.edits).toHaveLength(2);
    expect(second.summary).toBe('step 2');

    const sessions = readSessions(dir);
    expect(sessions[0].message_ids).toEqual([first.id]); // not duplicated
  });

  it('starts a new message when the request text differs from the newest one', () => {
    const first = recordMessage(dir, { session_id: 'sess-1', developer: 'ada', request: 'task A', summary: 's1', edits: [mkEdit()] });
    const second = recordMessage(dir, { session_id: 'sess-1', developer: 'ada', request: 'task B', summary: 's2', edits: [mkEdit()] });
    expect(second.id).not.toBe(first.id);
    expect(readSessions(dir)[0].message_ids).toEqual([first.id, second.id]);
  });

  it('starts a new message per call when no request text is given at all', () => {
    const first = recordMessage(dir, { session_id: 'sess-1', developer: 'ada', summary: 's1', edits: [mkEdit()] });
    const second = recordMessage(dir, { session_id: 'sess-1', developer: 'ada', summary: 's2', edits: [mkEdit()] });
    expect(second.id).not.toBe(first.id);
    expect(first.request).toBeNull();
  });

  it('does not continue a newest message that is no longer "applied"', () => {
    const first = recordMessage(dir, { session_id: 'sess-1', developer: 'ada', request: 'task A', summary: 's1', edits: [mkEdit()] });
    const mutated: ActivityMessage = { ...first, status: 'reverted' };
    saveMessage(dir, mutated);
    const second = recordMessage(dir, { session_id: 'sess-1', developer: 'ada', request: 'task A', summary: 's2', edits: [mkEdit()] });
    expect(second.id).not.toBe(first.id);
  });

  it('continues an explicit message_id target regardless of session/request matching', () => {
    const first = recordMessage(dir, { session_id: 'sess-1', developer: 'ada', request: 'task A', summary: 's1', edits: [mkEdit()] });
    const second = recordMessage(dir, {
      session_id: 'sess-1', developer: 'ada', message_id: first.id, summary: 's2', edits: [mkEdit()]
    });
    expect(second.id).toBe(first.id);
    expect(second.edits).toHaveLength(2);
  });

  it('creates a fresh message when an explicit message_id does not resolve to anything', () => {
    const msg = recordMessage(dir, {
      session_id: 'sess-1', developer: 'ada', message_id: 'does-not-exist', summary: 's', edits: [mkEdit()]
    });
    expect(msg.id).not.toBe('does-not-exist');
    expect(readMessage(dir, msg.id)).toEqual(msg);
  });

  it('keeps the previous summary when a continuation call passes an empty summary', () => {
    const first = recordMessage(dir, { session_id: 'sess-1', developer: 'ada', request: 'task A', summary: 'first summary', edits: [mkEdit()] });
    const second = recordMessage(dir, { session_id: 'sess-1', developer: 'ada', request: 'task A', summary: '', edits: [mkEdit()] });
    expect(second.summary).toBe('first summary');
  });
});

describe('readMessage / listMessages', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('readMessage returns null when the message does not exist', () => {
    expect(readMessage(dir, 'nope')).toBeNull();
  });

  it('listMessages returns an empty array when no messages directory exists yet', () => {
    expect(listMessages(dir)).toEqual([]);
  });

  it('listMessages returns messages newest-created first', () => {
    const a: ActivityMessage = {
      id: 'a', session_id: 's', developer: null, created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z', request: null, summary: 'a', status: 'applied', edits: []
    };
    const b: ActivityMessage = { ...a, id: 'b', created_at: '2024-01-02T00:00:00.000Z', updated_at: '2024-01-02T00:00:00.000Z', summary: 'b' };
    saveMessage(dir, a);
    saveMessage(dir, b);
    const list = listMessages(dir);
    expect(list.map(m => m.id)).toEqual(['b', 'a']);
  });
});

describe('queryActivityLog', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function msg(overrides: Partial<ActivityMessage>): ActivityMessage {
    const createdAt = overrides.created_at ?? '2024-06-01T12:00:00.000Z';
    return {
      id: overrides.id || `m-${Math.random().toString(36).slice(2)}`,
      session_id: overrides.session_id ?? 'sess-1',
      developer: overrides.developer === undefined ? 'Ada' : overrides.developer,
      created_at: createdAt,
      updated_at: overrides.updated_at ?? createdAt,
      request: overrides.request === undefined ? 'add feature X' : overrides.request,
      summary: overrides.summary ?? 'added feature X',
      status: overrides.status ?? 'applied',
      edits: overrides.edits ?? [mkEdit({ node_id: 'n1', file_path: '/repo/a.ts' })]
    };
  }

  it('returns every distinct file/node touched and dedupes them', () => {
    const m = msg({
      edits: [
        mkEdit({ node_id: 'n1', file_path: '/repo/a.ts' }),
        mkEdit({ node_id: 'n1', file_path: '/repo/a.ts' }),
        mkEdit({ node_id: 'n2', file_path: '/repo/b.ts' })
      ]
    });
    saveMessage(dir, m);
    const result = queryActivityLog(dir);
    expect(result.total_messages).toBe(1);
    expect(result.entries[0].files).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(result.entries[0].node_ids).toEqual(['n1', 'n2']);
    expect(result.entries[0].edit_count).toBe(3);
    expect(result.all_files.sort()).toEqual(['/repo/a.ts', '/repo/b.ts']);
  });

  it('filters by developer case-insensitively', () => {
    saveMessage(dir, msg({ id: 'a', developer: 'Ada Lovelace' }));
    saveMessage(dir, msg({ id: 'b', developer: 'Bob' }));
    const result = queryActivityLog(dir, { developer: 'ada' });
    expect(result.entries.map(e => e.id)).toEqual(['a']);
  });

  it('excludes a message with a null developer when filtering by developer', () => {
    saveMessage(dir, msg({ id: 'a', developer: 'Ada Lovelace' }));
    saveMessage(dir, msg({ id: 'b', developer: null }));
    const result = queryActivityLog(dir, { developer: 'ada' });
    expect(result.entries.map(e => e.id)).toEqual(['a']);
  });

  it('filters by sessionId', () => {
    saveMessage(dir, msg({ id: 'a', session_id: 'sess-1' }));
    saveMessage(dir, msg({ id: 'b', session_id: 'sess-2' }));
    const result = queryActivityLog(dir, { sessionId: 'sess-2' });
    expect(result.entries.map(e => e.id)).toEqual(['b']);
  });

  it('filters by sinceHours', () => {
    const now = Date.now();
    saveMessage(dir, msg({ id: 'old', created_at: new Date(now - 10 * 3600_000).toISOString() }));
    saveMessage(dir, msg({ id: 'recent', created_at: new Date(now - 1 * 3600_000).toISOString() }));
    const result = queryActivityLog(dir, { sinceHours: 2 });
    expect(result.entries.map(e => e.id)).toEqual(['recent']);
  });

  it('since takes priority over sinceHours when both are given', () => {
    const now = Date.now();
    saveMessage(dir, msg({ id: 'old', created_at: new Date(now - 10 * 3600_000).toISOString() }));
    saveMessage(dir, msg({ id: 'recent', created_at: new Date(now - 1 * 3600_000).toISOString() }));
    // since = far in the past -> should include both, even though sinceHours would exclude 'old'
    const result = queryActivityLog(dir, { since: new Date(now - 100 * 3600_000).toISOString(), sinceHours: 2 });
    expect(result.entries.map(e => e.id).sort()).toEqual(['old', 'recent']);
  });

  it('filters by until (inclusive upper bound)', () => {
    saveMessage(dir, msg({ id: 'a', created_at: '2024-01-01T00:00:00.000Z' }));
    saveMessage(dir, msg({ id: 'b', created_at: '2024-06-01T00:00:00.000Z' }));
    const result = queryActivityLog(dir, { until: '2024-03-01T00:00:00.000Z' });
    expect(result.entries.map(e => e.id)).toEqual(['a']);
  });

  it('filters by requirementContains against request OR summary', () => {
    saveMessage(dir, msg({ id: 'a', request: 'fix login bug', summary: 'fixed login' }));
    saveMessage(dir, msg({ id: 'b', request: null, summary: 'unrelated payments change' }));
    const byRequest = queryActivityLog(dir, { requirementContains: 'LOGIN' });
    expect(byRequest.entries.map(e => e.id)).toEqual(['a']);
    const bySummary = queryActivityLog(dir, { requirementContains: 'payments' });
    expect(bySummary.entries.map(e => e.id)).toEqual(['b']);
  });

  it('composes multiple filters together (AND)', () => {
    saveMessage(dir, msg({ id: 'a', developer: 'Ada', request: 'add feature X' }));
    saveMessage(dir, msg({ id: 'b', developer: 'Bob', request: 'add feature X' }));
    const result = queryActivityLog(dir, { developer: 'ada', requirementContains: 'feature X' });
    expect(result.entries.map(e => e.id)).toEqual(['a']);
  });

  it('respects the limit option', () => {
    saveMessage(dir, msg({ id: 'a', created_at: '2024-01-01T00:00:00.000Z' }));
    saveMessage(dir, msg({ id: 'b', created_at: '2024-01-02T00:00:00.000Z' }));
    saveMessage(dir, msg({ id: 'c', created_at: '2024-01-03T00:00:00.000Z' }));
    const result = queryActivityLog(dir, { limit: 2 });
    expect(result.entries).toHaveLength(2);
  });

  it('returns an empty result when there are no messages at all', () => {
    const result = queryActivityLog(dir);
    expect(result).toEqual({ total_messages: 0, total_matched: 0, all_files: [], entries: [] });
  });

  it('reports the pre-limit match count alongside the returned count', () => {
    saveMessage(dir, msg({ id: 'a', created_at: '2024-01-01T00:00:00.000Z' }));
    saveMessage(dir, msg({ id: 'b', created_at: '2024-01-02T00:00:00.000Z' }));
    saveMessage(dir, msg({ id: 'c', created_at: '2024-01-03T00:00:00.000Z' }));
    const result = queryActivityLog(dir, { limit: 2 });
    // total_messages is what came back; total_matched is what the filters actually matched.
    expect(result.total_messages).toBe(2);
    expect(result.total_matched).toBe(3);
  });
});

describe('ensureGitignored', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('adds a gitignore entry for local/ and is idempotent on a second call', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const activity = require('../../src/db/activity');
      activity.ensureGitignored(dir);
      const gitignorePath = path.join(dir, '.gitignore');
      const content1 = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content1).toContain('local/');

      // Second call, same process: module-level "already checked" flag short-circuits it.
      activity.ensureGitignored(dir);
      const content2 = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content2).toBe(content1);
    });
  });

  it('does not duplicate the entry when .gitignore already contains local/', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const activity = require('../../src/db/activity');
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\nlocal/\n');
      activity.ensureGitignored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      expect(content).toBe('node_modules/\nlocal/\n');
    });
  });

  it('appends a newline before local/ when the existing file lacks a trailing newline', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const activity = require('../../src/db/activity');
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/');
      activity.ensureGitignored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      expect(content).toBe('node_modules/\nlocal/\n');
    });
  });

  it('does not throw when the gitignore write fails (best-effort)', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const activity = require('../../src/db/activity');
      const spy = jest.spyOn(fsReal, 'writeFileSync').mockImplementation(() => { throw new Error('boom'); });
      try {
        expect(() => activity.ensureGitignored(dir)).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('workflow binding (local, per session)', () => {
    let dir: string;
    beforeEach(() => { dir = mkTempDir(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('binds and unbinds a session that already exists', () => {
      createSession(dir, 'sess-a', 'Dev');
      expect(readSessionWorkflow(dir, 'sess-a')).toBeNull();

      bindSessionWorkflow(dir, 'sess-a', 'wf_1', 'Dev');
      expect(readSessionWorkflow(dir, 'sess-a')).toBe('wf_1');

      bindSessionWorkflow(dir, 'sess-a', null, 'Dev');
      expect(readSessionWorkflow(dir, 'sess-a')).toBeNull();
    });

    it('creates the session row when binding before start_session has run', () => {
      // An agent can legitimately bind before its first commit exists, so this must not depend on
      // the session having been created first.
      bindSessionWorkflow(dir, 'sess-new', 'wf_1', 'Dev');
      const sessions = readSessions(dir);
      expect(sessions.map(s => s.id)).toEqual(['sess-new']);
      expect(sessions[0].workflow_id).toBe('wf_1');
      expect(sessions[0].developer).toBe('Dev');
    });

    it('creates the session row with a null developer when none is supplied', () => {
      // An agent that binds before start_session has run may not know the developer name yet;
      // the row still has to exist so the binding is readable.
      bindSessionWorkflow(dir, 'sess-anon', 'wf_1');
      const session = readSessions(dir).find(s => s.id === 'sess-anon')!;
      expect(session.developer).toBeNull();
      expect(session.workflow_id).toBe('wf_1');
    });

    it('reports no binding for a session that does not exist at all', () => {
      expect(readSessionWorkflow(dir, 'never-seen')).toBeNull();
    });

    it('lastBoundWorkflowId picks the newest bound session and skips the one asking', async () => {
      // Derived rather than stored: a separate "last workflow" field would be a second copy of a
      // fact already recorded here, and second copies drift — the exact failure of the global
      // active pointer this replaced.
      expect(lastBoundWorkflowId(dir)).toBeNull();

      bindSessionWorkflow(dir, 'sess-old', 'wf_old', 'Dev');
      await new Promise(r => setTimeout(r, 5));
      bindSessionWorkflow(dir, 'sess-new', 'wf_new', 'Dev');

      expect(lastBoundWorkflowId(dir)).toBe('wf_new');
      // The session asking gets its own binding skipped, so it is not offered back to itself.
      expect(lastBoundWorkflowId(dir, 'sess-new')).toBe('wf_old');
      expect(lastBoundWorkflowId(dir, 'sess-new-and-old')).toBe('wf_new');
    });

    it('ignores unbound sessions when looking for the last one', () => {
      createSession(dir, 'sess-plain', 'Dev');
      expect(lastBoundWorkflowId(dir)).toBeNull();
      bindSessionWorkflow(dir, 'sess-plain', 'wf_1', 'Dev');
      bindSessionWorkflow(dir, 'sess-plain', null, 'Dev');
      expect(lastBoundWorkflowId(dir)).toBeNull();
    });
  });
});
