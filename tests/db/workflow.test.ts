import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeFixture } from '../helpers/fixture';
import { importWorkflowDocs, importOneFlowDoc, deriveTitleFromMarkdown } from '../../src/db/workflow-import';
import { DevMindDatabase, WORKFLOW_SCHEMA_VERSION, WORKFLOW_SIDECAR_FILE } from '../../src/db/database';

/** Raw access to the live better-sqlite3 connection — `db` is `private` at the TS level only. */
function raw(db: DevMindDatabase) {
  return (db as any).db as import('better-sqlite3').Database;
}

describe('DevMindDatabase — workflow context vault', () => {
  describe('createWorkflow', () => {
    it('creates a workflow without making it "active" anywhere — being on one is a session-local fact', () => {
      // The whole point of the rewrite: there is no project-wide active pointer to move. The old
      // one lived in system_meta AND was serialized into the committed workflow.json, so one
      // developer's "currently working on" travelled through git and displaced everyone else's.
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wf1 = fx.db.createWorkflow('Wallet Integration', 'Wallet end to end');
        const wf2 = fx.db.createWorkflow('Search Revamp', 'Better search');

        expect(wf1.archived).toBe(0);
        expect(wf2.archived).toBe(0);
        expect((fx.db as any).getActiveWorkflow).toBeUndefined();
        expect(fx.db.getSystemMeta('active_workflow_id')).toBeFalsy();

        // Both are simply listed, newest-touched first — no status to filter on.
        expect(fx.db.listWorkflows().map(w => w.id)).toEqual([wf2.id, wf1.id]);
        expect(fx.db.countWorkflows()).toBe(2);
      } finally {
        fx.cleanup();
      }
    });

    it('writes a v2 workflow.json with no is_active flag', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wf = fx.db.createWorkflow('Wallet Integration', 'Wallet end to end');
        const jsonPath = path.join(path.dirname(fx.devmindPath), '.devmind', 'workflows', wf.id, 'workflow.json');
        const onDisk = fs.existsSync(jsonPath)
          ? JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
          : JSON.parse(fs.readFileSync(path.join(fx.devmindPath, 'workflows', wf.id, 'workflow.json'), 'utf-8'));

        expect(onDisk.schema_version).toBe(WORKFLOW_SCHEMA_VERSION);
        expect(onDisk.archived).toBe(0);
        // The two fields that used to leak one developer's session state to the whole team.
        expect(onDisk).not.toHaveProperty('is_active');
        expect(onDisk).not.toHaveProperty('status');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('archiving', () => {
    it('hides a workflow from the default list and brings it back, keeping its steps', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wf = fx.db.createWorkflow('Old Feature', 'Long done');
        fx.db.addWorkflowStep(wf.id, { summary: 'did a thing' });

        fx.db.setWorkflowArchived(wf.id, true);
        expect(fx.db.listWorkflows().map(w => w.id)).toEqual([]);
        expect(fx.db.countWorkflows()).toBe(0);
        // Hidden, not deleted — the distinction that makes archiving safe to use freely.
        expect(fx.db.listWorkflows({ includeArchived: true }).map(w => w.id)).toEqual([wf.id]);
        expect(fx.db.getWorkflowContext(wf.id).steps).toHaveLength(1);

        fx.db.setWorkflowArchived(wf.id, false);
        expect(fx.db.listWorkflows().map(w => w.id)).toEqual([wf.id]);
      } finally {
        fx.cleanup();
      }
    });

    it('throws for an unknown workflow id', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        expect(() => fx.db.setWorkflowArchived('wf_nope', true)).toThrow(/Workflow not found/);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('listWorkflows — query and paging', () => {
    it('matches on name AND description, which the old searchWorkflows never did', () => {
      // searchWorkflows scanned step summaries and artifact names only, so looking a workflow up
      // by its own name returned nothing — the one search anybody actually tries.
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wallet = fx.db.createWorkflow('Wallet Integration', 'Stripe payouts');
        const search = fx.db.createWorkflow('Search Revamp', 'BM25 plus vectors');

        expect(fx.db.listWorkflows({ query: 'wallet' }).map(w => w.id)).toEqual([wallet.id]);
        expect(fx.db.listWorkflows({ query: 'WALLET' }).map(w => w.id)).toEqual([wallet.id]);
        expect(fx.db.listWorkflows({ query: 'vectors' }).map(w => w.id)).toEqual([search.id]);
        expect(fx.db.listWorkflows({ query: 'nothing-matches-this' })).toEqual([]);
        expect(fx.db.countWorkflows({ query: 'wallet' })).toBe(1);
      } finally {
        fx.cleanup();
      }
    });

    it('escapes LIKE metacharacters so a literal % or _ is not a wildcard', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        fx.db.createWorkflow('Discount 50% Flow', 'percent off');
        fx.db.createWorkflow('Unrelated', 'nothing here');
        expect(fx.db.listWorkflows({ query: '%' }).map(w => w.name)).toEqual(['Discount 50% Flow']);
      } finally {
        fx.cleanup();
      }
    });

    it('pages with limit/offset while countWorkflows stays exact', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        for (let i = 0; i < 5; i++) fx.db.createWorkflow(`WF ${i}`, 'x');
        const first = fx.db.listWorkflows({ limit: 2 });
        const second = fx.db.listWorkflows({ limit: 2, offset: 2 });
        expect(first).toHaveLength(2);
        expect(second).toHaveLength(2);
        expect(new Set([...first, ...second].map(w => w.id)).size).toBe(4);
        expect(fx.db.countWorkflows()).toBe(5);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('addWorkflowStep', () => {
    it('stores reasoning, node ids and doc paths, and increments step_index per workflow', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wf = fx.db.createWorkflow('Wallet', 'x');
        const other = fx.db.createWorkflow('Other', 'y');

        const s1 = fx.db.addWorkflowStep(wf.id, {
          summary: 'Added the balance endpoint',
          reasoning: 'Why: the app polled a third party on every render',
          nodeIds: ['{app}/wallet.ts#getBalance', '{app}/wallet.ts#WalletService'],
          docPaths: ['docs/wallet-spec.md'],
          sessionId: 'sess-1'
        });
        expect(s1.step_index).toBe(1);
        expect(s1.reasoning).toContain('polled a third party');
        expect(JSON.parse(s1.node_ids!)).toEqual(['{app}/wallet.ts#getBalance', '{app}/wallet.ts#WalletService']);
        expect(JSON.parse(s1.doc_paths!)).toEqual(['docs/wallet-spec.md']);
        expect(s1.session_id).toBe('sess-1');

        expect(fx.db.addWorkflowStep(wf.id, { summary: 'second' }).step_index).toBe(2);
        // Indexes are per workflow, not global.
        expect(fx.db.addWorkflowStep(other.id, { summary: 'first here' }).step_index).toBe(1);
      } finally {
        fx.cleanup();
      }
    });

    it('records a research step that touched no code at all', () => {
      // The case nothing else in DevsMind captures: git has the diff and history has the per-node
      // reasoning, but neither records what was evaluated and rejected.
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wf = fx.db.createWorkflow('Payments', 'x');
        const step = fx.db.addWorkflowStep(wf.id, {
          summary: 'Chose Stripe over Razorpay',
          reasoning: 'Decision: Razorpay has no split settlements, which the marketplace payout needs.'
        });
        expect(step.node_ids).toBeNull();
        expect(step.doc_paths).toBeNull();
        expect(step.reasoning).toContain('split settlements');
      } finally {
        fx.cleanup();
      }
    });

    it('stores empty arrays as null so "touched nothing" and "predates the column" read alike', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wf = fx.db.createWorkflow('Wallet', 'x');
        const step = fx.db.addWorkflowStep(wf.id, { summary: 's', nodeIds: [], docPaths: [] });
        expect(step.node_ids).toBeNull();
        expect(step.doc_paths).toBeNull();
      } finally {
        fx.cleanup();
      }
    });

    it('throws clearly for an unknown workflow id', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        expect(() => fx.db.addWorkflowStep('wf_nope', { summary: 's' })).toThrow(/Workflow not found/);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getWorkflowContext', () => {
    it('returns steps in order with an exact total, and artifacts as metadata only', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wf = fx.db.createWorkflow('Wallet', 'x');
        fx.db.addWorkflowStep(wf.id, { summary: 'one' });
        fx.db.addWorkflowStep(wf.id, { summary: 'two' });
        fx.db.addWorkflowArtifact(wf.id, { type: 'imported_doc', sourceName: 'spec.md', content: '# Spec' });

        const ctx = fx.db.getWorkflowContext(wf.id);
        expect(ctx.steps.map(s => s.summary)).toEqual(['one', 'two']);
        expect(ctx.steps_total).toBe(2);
        expect(ctx.steps_offset).toBe(0);
        expect(ctx.artifacts).toHaveLength(1);
        // Content is never inlined now — a path is enough, and inlining whole imported docs was
        // the single largest thing a workflow response could emit.
        expect(ctx.artifacts[0]).not.toHaveProperty('content');
        expect(ctx.artifacts[0].file_path).toBeTruthy();
      } finally {
        fx.cleanup();
      }
    });

    it('pages forward with limit/offset and backward with last_n, reporting the right offset for each', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wf = fx.db.createWorkflow('Wallet', 'x');
        for (let i = 1; i <= 6; i++) fx.db.addWorkflowStep(wf.id, { summary: `step ${i}` });

        const page = fx.db.getWorkflowContext(wf.id, { limit: 2, offset: 2 });
        expect(page.steps.map(s => s.summary)).toEqual(['step 3', 'step 4']);
        expect(page.steps_total).toBe(6);
        expect(page.steps_offset).toBe(2);

        // last_n reads the tail — what "catch me up" actually means — still chronological.
        const tail = fx.db.getWorkflowContext(wf.id, { last_n: 2 });
        expect(tail.steps.map(s => s.summary)).toEqual(['step 5', 'step 6']);
        expect(tail.steps_offset).toBe(4);
        expect(tail.steps_total).toBe(6);
      } finally {
        fx.cleanup();
      }
    });

    it('accepts a limit with no offset, defaulting to the first page', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wf = fx.db.createWorkflow('Wallet', 'x');
        for (let i = 1; i <= 3; i++) fx.db.addWorkflowStep(wf.id, { summary: `step ${i}` });
        expect(fx.db.getWorkflowContext(wf.id, { limit: 2 }).steps.map(s => s.summary)).toEqual(['step 1', 'step 2']);
      } finally {
        fx.cleanup();
      }
    });

    it('throws for an unknown workflow id, from both the context read and the step read', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        expect(() => fx.db.getWorkflowContext('wf_nope')).toThrow(/Workflow not found/);
        expect(() => fx.db.getWorkflowSteps('wf_nope')).toThrow(/Workflow not found/);
        expect(() => fx.db.addWorkflowArtifact('wf_nope', { type: 'note', sourceName: 'n.md', content: 'x' }))
          .toThrow(/Workflow not found/);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('surviving a teammate on an older build', () => {
    it('restores reasoning/node_ids/doc_paths/archived after a v1 client rewrote workflow.json', () => {
      // The scenario a single file could not survive: `devsmind sync` re-serializes every
      // workflow.json from whatever columns the local build knows, so a teammate who pulls on an
      // older version and syncs rewrites the file WITHOUT the v2 fields and commits that loss.
      // The sidecar exists precisely because an older build has no idea it is there to rewrite.
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wf = fx.db.createWorkflow('Wallet', 'x');
        const step = fx.db.addWorkflowStep(wf.id, {
          summary: 'Added the balance endpoint',
          reasoning: 'Why: it polled a third party on every render',
          nodeIds: ['{app}/wallet.ts#getBalance'],
          docPaths: ['docs/wallet.md']
        });
        fx.db.setWorkflowArchived(wf.id, true);

        const dir = path.join(fx.devmindPath, 'workflows', wf.id);
        expect(fs.existsSync(path.join(dir, WORKFLOW_SIDECAR_FILE))).toBe(true);

        // Simulate the downgrade: rewrite workflow.json in the v1 shape, exactly as an older
        // build's writeWorkflowToDisk would. The sidecar is left alone, because v1 cannot see it.
        const current = JSON.parse(fs.readFileSync(path.join(dir, 'workflow.json'), 'utf-8'));
        fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
          id: current.id, name: current.name, description: current.description,
          status: 'paused', created_at: current.created_at, updated_at: current.updated_at,
          is_active: false,
          steps: current.steps.map((st: any) => ({
            id: st.id, step_index: st.step_index, summary: st.summary,
            pending_tasks: null, history_ids: null, session_id: st.session_id, created_at: st.created_at
          })),
          artifact_index: []
        }, null, 2));

        // A fresh brain reading that tree gets everything back.
        fx.db.close();
        fs.rmSync(path.join(fx.devmindPath, 'brain.db'), { force: true });
        const reopened = new DevMindDatabase(path.join(fx.devmindPath, 'brain.db'));
        try {
          const restored = reopened.getWorkflowSteps(wf.id).find(x => x.id === step.id)!;
          expect(restored.reasoning).toContain('polled a third party');
          expect(JSON.parse(restored.node_ids!)).toEqual(['{app}/wallet.ts#getBalance']);
          expect(JSON.parse(restored.doc_paths!)).toEqual(['docs/wallet.md']);
          // `archived` has no v1 field either, so it rides in the sidecar too.
          expect(reopened.getWorkflow(wf.id)!.archived).toBe(1);
        } finally {
          reopened.close();
        }
      } finally {
        fx.cleanup();
      }
    });

    it('falls back to the v1 shape when the sidecar is missing or corrupt, rather than losing the workflow', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const wf = fx.db.createWorkflow('Wallet', 'x');
        fx.db.addWorkflowStep(wf.id, { summary: 'a step', reasoning: 'Why: because' });

        const dir = path.join(fx.devmindPath, 'workflows', wf.id);
        fs.writeFileSync(path.join(dir, WORKFLOW_SIDECAR_FILE), '{not json');

        fx.db.close();
        fs.rmSync(path.join(fx.devmindPath, 'brain.db'), { force: true });
        const reopened = new DevMindDatabase(path.join(fx.devmindPath, 'brain.db'));
        try {
          const steps = reopened.getWorkflowSteps(wf.id);
          expect(steps).toHaveLength(1);
          expect(steps[0].summary).toBe('a step');
          // workflow.json still carries the fields inline for a same-version reader, so a corrupt
          // sidecar costs nothing here — it only matters once a v1 client has stripped them.
          expect(steps[0].reasoning).toBe('Why: because');
        } finally {
          reopened.close();
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('migration from the pre-v2 step shape', () => {
    /** Rebuilds `workflow_steps` exactly as it was before v2, then re-opens the brain. */
    function seedLegacyStep(fx: ReturnType<typeof makeFixture>, workflowId: string, historyIds: string[]) {
      const db = raw(fx.db);
      db.exec('DROP TABLE workflow_steps');
      db.exec(`CREATE TABLE workflow_steps (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, step_index INTEGER NOT NULL,
        summary TEXT NOT NULL, pending_tasks TEXT, history_ids TEXT, session_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.prepare(
        'INSERT INTO workflow_steps (id, workflow_id, step_index, summary, history_ids, created_at) VALUES (?, ?, 1, ?, ?, ?)'
      ).run('legacy-step', workflowId, 'legacy summary', JSON.stringify(historyIds), new Date().toISOString());
    }

    it('adds the new columns and backfills node_ids/reasoning from the old history_ids', async () => {
      const fx = makeFixture();
      try {
        const wf = fx.db.createWorkflow('Legacy', 'x');
        // A real node + history row to resolve against (history has an FK onto nodes).
        fx.db.upsertNode({ id: '{app}/foo.ts#greet', type: 'function', name: 'greet', file_path: 'foo.ts' });
        const history = fx.db.updateHistory({
          node_id: '{app}/foo.ts#greet',
          code_snapshot: 'export function greet() {}',
          reasoning: 'Why: it needed to exist',
          session_id: 'sess-legacy'
        });
        seedLegacyStep(fx, wf.id, [history.id]);

        // Re-open: initSchema runs the guarded ALTERs and then the backfill.
        const reopened = new DevMindDatabase(path.join(fx.devmindPath, 'brain.db'));
        try {
          const step = reopened.getWorkflowContext(wf.id).steps[0];
          expect(step.summary).toBe('legacy summary');
          expect(JSON.parse(step.node_ids!)).toEqual(['{app}/foo.ts#greet']);
          expect(step.reasoning).toContain('it needed to exist');
        } finally {
          reopened.close();
        }
      } finally {
        fx.cleanup();
      }
    });

    it('is idempotent — a second open changes nothing and does not throw', () => {
      const fx = makeFixture();
      try {
        const wf = fx.db.createWorkflow('Legacy', 'x');
        seedLegacyStep(fx, wf.id, ['no-such-history-id']);

        const first = new DevMindDatabase(path.join(fx.devmindPath, 'brain.db'));
        const afterFirst = first.getWorkflowContext(wf.id).steps[0];
        first.close();

        const second = new DevMindDatabase(path.join(fx.devmindPath, 'brain.db'));
        try {
          const afterSecond = second.getWorkflowContext(wf.id).steps[0];
          expect(afterSecond).toEqual(afterFirst);
        } finally {
          second.close();
        }
      } finally {
        fx.cleanup();
      }
    });

    it('degrades rather than throwing when a step cites history rows that no longer exist', () => {
      // Pruned history is normal on an old brain. The step has to survive on its summary alone
      // rather than blocking the open or vanishing from the timeline.
      const fx = makeFixture();
      try {
        const wf = fx.db.createWorkflow('Legacy', 'x');
        seedLegacyStep(fx, wf.id, ['gone-1', 'gone-2']);

        const reopened = new DevMindDatabase(path.join(fx.devmindPath, 'brain.db'));
        try {
          const step = reopened.getWorkflowContext(wf.id).steps[0];
          expect(step.summary).toBe('legacy summary');
          expect(JSON.parse(step.node_ids!)).toEqual([]);
          expect(step.reasoning).toBeNull();
        } finally {
          reopened.close();
        }
      } finally {
        fx.cleanup();
      }
    });

    it('tolerates a malformed history_ids blob instead of failing the open', () => {
      const fx = makeFixture();
      try {
        const wf = fx.db.createWorkflow('Legacy', 'x');
        seedLegacyStep(fx, wf.id, []);
        raw(fx.db).prepare('UPDATE workflow_steps SET history_ids = ? WHERE id = ?').run('{not json', 'legacy-step');

        const reopened = new DevMindDatabase(path.join(fx.devmindPath, 'brain.db'));
        try {
          expect(JSON.parse(reopened.getWorkflowContext(wf.id).steps[0].node_ids!)).toEqual([]);
        } finally {
          reopened.close();
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('importWorkflowDoc / importWorkflowDocs (workflow-import.ts)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-flowdocs-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('deriveTitleFromMarkdown: reads # Title / ## Summary, and falls back to the filename otherwise', () => {
      const withTitle = deriveTitleFromMarkdown(
        '# Checkout Flow (v2)\n\n## Summary\n\nHandles the checkout process end to end.\n',
        'checkout.md'
      );
      expect(withTitle.name).toBe('Checkout Flow');
      expect(withTitle.description).toBe('Handles the checkout process end to end.');

      const withoutTitle = deriveTitleFromMarkdown('Just some free-form notes with no heading.', 'my-notes_flow.md');
      expect(withoutTitle.name).toBe('My Notes');
      expect(withoutTitle.description).toBe('Just some free-form notes with no heading.');
    });

    it('importWorkflowDocs imports every top-level .md file in a folder as a workflow named after its parsed title', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        fs.writeFileSync(
          path.join(tmpDir, 'checkout.md'),
          '# Checkout Flow\n\n## Summary\n\nHandles the checkout process end to end.\n'
        );
        fs.writeFileSync(
          path.join(tmpDir, 'no-heading-notes.md'),
          'Some free-form notes describing a login flow with no markdown heading at all.'
        );

        const result = importWorkflowDocs(fx.db, tmpDir);
        expect(result.created.sort()).toEqual(['Checkout Flow', 'No Heading Notes'].sort());
        expect(result.updated).toEqual([]);
        expect(result.skipped).toEqual([]);

        const wf = fx.db.listWorkflows().find(w => w.name === 'Checkout Flow');
        expect(wf?.archived).toBe(0);

        const ctx = fx.db.getWorkflowContext(wf!.id);
        expect(ctx.artifacts).toHaveLength(1);
        expect(ctx.artifacts[0].type).toBe('imported_doc');
        // The doc's bytes stay on disk; the context hands back where to find them.
        expect(fs.readFileSync(ctx.artifacts[0].file_path, 'utf-8')).toContain('Handles the checkout process end to end.');

        // Re-running the same import is idempotent by name: reports "updated", not duplicated.
        const second = importWorkflowDocs(fx.db, tmpDir);
        expect(second.created).toEqual([]);
        expect(second.updated.sort()).toEqual(['Checkout Flow', 'No Heading Notes'].sort());
        expect(fx.db.listWorkflows()).toHaveLength(2); // still exactly 2, no duplicates
      } finally {
        fx.cleanup();
      }
    });

    it('importOneFlowDoc imports a single file and reflects created:true/false correctly', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const filePath = path.join(tmpDir, 'onboarding.md');
        fs.writeFileSync(filePath, '# Onboarding Flow\n\nWalks a new user through setup.');

        const first = importOneFlowDoc(fx.db, filePath);
        expect(first.created).toBe(true);
        expect(first.name).toBe('Onboarding Flow');

        const second = importOneFlowDoc(fx.db, filePath);
        expect(second.created).toBe(false);
        expect(second.name).toBe('Onboarding Flow');
      } finally {
        fx.cleanup();
      }
    });

    it('importWorkflowDocs via filePath skips a non-.md file and a missing file', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const txtFile = path.join(tmpDir, 'ignore-me.txt');
        fs.writeFileSync(txtFile, 'not markdown');

        const skippedTxt = importWorkflowDocs(fx.db, undefined, txtFile);
        expect(skippedTxt.skipped).toEqual([txtFile]);
        expect(skippedTxt.created).toEqual([]);

        const missing = path.join(tmpDir, 'does-not-exist.md');
        const skippedMissing = importWorkflowDocs(fx.db, undefined, missing);
        expect(skippedMissing.skipped).toEqual([missing]);
      } finally {
        fx.cleanup();
      }
    });

    it('importWorkflowDocs skips a file whose import throws (e.g. a DB-level failure) instead of aborting the whole batch', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        fs.writeFileSync(path.join(tmpDir, 'good.md'), '# Good Doc\n\n## Summary\n\nThis one imports fine.\n');
        fs.writeFileSync(path.join(tmpDir, 'bad.md'), '# Bad Doc\n\n## Summary\n\nThis one fails to import.\n');

        const spy = jest.spyOn(fx.db, 'importWorkflowDoc').mockImplementation((name: string, ...rest: any[]) => {
          if (name === 'Bad Doc') throw new Error('simulated db failure');
          return (jest.requireActual('../../src/db/database') as any).DevMindDatabase.prototype.importWorkflowDoc
            .apply(fx.db, [name, ...rest]);
        });

        const result = importWorkflowDocs(fx.db, tmpDir);
        expect(result.created).toEqual(['Good Doc']);
        expect(result.skipped.some(f => f.endsWith('bad.md'))).toBe(true);

        spy.mockRestore();
      } finally {
        fx.cleanup();
      }
    });

    it('throws when neither folder_path nor file_path is given', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        expect(() => importWorkflowDocs(fx.db)).toThrow(/Provide either folder_path or file_path/);
      } finally {
        fx.cleanup();
      }
    });

    it('throws when folderPath is not a directory', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const notADir = path.join(tmpDir, 'nope');
        expect(() => importWorkflowDocs(fx.db, notADir)).toThrow(/Not a directory/);
      } finally {
        fx.cleanup();
      }
    });
  });
});
