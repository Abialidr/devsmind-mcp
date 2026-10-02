import { makeFixture, repoFile } from '../helpers/fixture';
import { DevMindDatabase } from '../../src/db/database';

describe('DevMindDatabase.searchWorkflowSteps & searchNodes workflow_steps integration', () => {
  it('returns [] for empty query tokens or when no workflow steps exist', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      expect(fx.db.searchWorkflowSteps([])).toEqual([]);
      expect(fx.db.searchWorkflowSteps(['checkout'])).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('matches workflow steps by summary and by reasoning', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf1 = fx.db.createWorkflow('Instagram Feature', 'Instagram sharing integration');
      const step1 = fx.db.addWorkflowStep(wf1.id, {
        summary: 'Added native Instagram Reels share handler with resolveActivity',
        reasoning: 'Needed direct intent dispatch without webview fallback'
      });

      const wf2 = fx.db.createWorkflow('Payment Gateway', 'Stripe payment integration');
      fx.db.addWorkflowStep(wf2.id, {
        summary: 'Configured webhook verification',
        reasoning: 'Replaced secret rotation timer'
      });

      // Match via summary
      const matchSummary = fx.db.searchWorkflowSteps(['reels']);
      expect(matchSummary.length).toBe(1);
      expect(matchSummary[0].workflow_id).toBe(wf1.id);
      expect(matchSummary[0].workflow_name).toBe('Instagram Feature');
      expect(matchSummary[0].step_index).toBe(step1.step_index);
      expect(matchSummary[0].summary).toBe(step1.summary);
      expect(matchSummary[0].matched_terms).toContain('reel');
      expect(matchSummary[0].relevance).toBe(100);

      // Match via reasoning
      const matchReasoning = fx.db.searchWorkflowSteps(['intent', 'dispatch']);
      expect(matchReasoning.length).toBe(1);
      expect(matchReasoning[0].workflow_id).toBe(wf1.id);
      expect(matchReasoning[0].matched_terms).toEqual(expect.arrayContaining(['intent', 'dispatch']));
    } finally {
      fx.cleanup();
    }
  });

  it('extracts nodes_touched correctly from step node_ids JSON', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Auth Flow', 'User auth');
      const step = fx.db.addWorkflowStep(wf.id, {
        summary: 'Updated login validation and token refresh',
        nodeIds: ['node_login_form', 'node_refresh_token']
      });

      const res = fx.db.searchWorkflowSteps(['login']);
      expect(res.length).toBe(1);
      expect(res[0].nodes_touched).toEqual(['node_login_form', 'node_refresh_token']);
    } finally {
      fx.cleanup();
    }
  });

  it('excludes steps from archived workflows', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Old Feature', 'Deprecated flow');
      fx.db.addWorkflowStep(wf.id, { summary: 'Legacy checkout button implementation' });

      // Before archive
      expect(fx.db.searchWorkflowSteps(['checkout']).length).toBe(1);

      // Archive workflow
      fx.db.setWorkflowArchived(wf.id, true);

      // After archive
      expect(fx.db.searchWorkflowSteps(['checkout'])).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('caps results to limit and orders by relevance score', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Order System', 'Managing orders');
      // Create 7 steps mentioning invoice
      for (let i = 1; i <= 7; i++) {
        fx.db.addWorkflowStep(wf.id, {
          summary: i === 3 ? 'Invoice tax invoice calculation with heavy invoice terms' : `Invoice step ${i}`
        });
      }

      const res = fx.db.searchWorkflowSteps(['invoice'], 3);
      expect(res.length).toBe(3);
      // The step with higher term frequency should rank first
      expect(res[0].step_index).toBe(3);
      expect(res[0].relevance).toBe(100);
      expect(res[1].relevance).toBeLessThanOrEqual(100);
    } finally {
      fx.cleanup();
    }
  });

  it('integrates into searchNodes in default one-pass mode', async () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Instagram Flow', 'Instagram story and reel upload');
      fx.db.addWorkflowStep(wf.id, {
        summary: 'Configured Instagram reels upload permissions',
        reasoning: 'iOS Photos library permission required'
      });

      const result = await fx.db.searchNodes('instagram reels upload');
      expect(result.workflow_steps).toBeDefined();
      expect(result.workflow_steps!.length).toBe(1);
      expect(result.workflow_steps![0].workflow_name).toBe('Instagram Flow');
      expect(result.workflow_steps![0].matched_terms).toContain('instagram');
    } finally {
      fx.cleanup();
    }
  });

  it('respects scope: "steps" to return only workflow steps and skip nodes/files', async () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Cart Flow', 'Shopping cart');
      fx.db.addWorkflowStep(wf.id, { summary: 'Cart item count update on badge' });

      const result = await fx.db.searchNodes('cart badge', { scope: 'steps' });
      expect(result.nodes).toEqual([]);
      expect(result.files).toEqual([]);
      expect(result.workflow_steps).toBeDefined();
      expect(result.workflow_steps!.length).toBe(1);
      expect(result.workflow_steps![0].summary).toBe('Cart item count update on badge');
    } finally {
      fx.cleanup();
    }
  });

  it('returns appropriate hint when scope: "steps" finds nothing', async () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const result = await fx.db.searchNodes('nonexistent_concept_xyz', { scope: 'steps' });
      expect(result.workflow_steps).toEqual([]);
      expect(result.hint).toContain('No workflow steps matched this query');
    } finally {
      fx.cleanup();
    }
  });

  it('respects scope: "nodes" and scope: "files" to exclude workflow steps', async () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Cart Flow', 'Shopping cart');
      fx.db.addWorkflowStep(wf.id, { summary: 'Cart item count update on badge' });

      const nodesRes = await fx.db.searchNodes('cart', { scope: 'nodes' });
      expect(nodesRes.workflow_steps).toEqual([]);

      const filesRes = await fx.db.searchNodes('cart', { scope: 'files' });
      expect(filesRes.workflow_steps).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('returns [] for untokenizable query tokens', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Noise', 'Symbols only');
      fx.db.addWorkflowStep(wf.id, { summary: 'checkout flow exists' });

      expect(fx.db.searchWorkflowSteps(['!!!'])).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('ignores malformed step node_ids JSON instead of failing the search', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Malformed Step', 'Bad sidecar data');
      const step = fx.db.addWorkflowStep(wf.id, {
        summary: 'Malformed checkout decision',
        nodeIds: ['node_checkout']
      });
      (fx.db as any).db.prepare('UPDATE workflow_steps SET node_ids = ? WHERE id = ?').run('not json', step.id);

      const res = fx.db.searchWorkflowSteps(['checkout']);
      expect(res).toHaveLength(1);
      expect(res[0].nodes_touched).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  it('returns [] when workflow steps exist but none match the query tokens', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Checkout', 'Payment flow');
      fx.db.addWorkflowStep(wf.id, { summary: 'Configured payment capture' });

      expect(fx.db.searchWorkflowSteps(['instagram'])).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('keeps exact identifier search node-only when scope is nodes', async () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      fx.db.upsertNode({
        id: '{app}/exact.ts#exactSymbol',
        type: 'function',
        name: 'exactSymbol',
        file_path: repoFile(fx, 'exact.ts'),
        description: 'Exact symbol for scoped identifier search.'
      });

      const result = await fx.db.searchNodes('exactSymbol', { scope: 'nodes' });
      expect(result.nodes.map(n => n.id)).toContain('{app}/exact.ts#exactSymbol');
      expect(result.files).toEqual([]);
      expect(result.files_total).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('reports perf debug timings for scoped node/file searches', async () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    const prev = process.env.DEVSMIND_PERF_DEBUG;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.env.DEVSMIND_PERF_DEBUG = '1';
      await fx.db.searchNodes('no_such_symbol_for_perf_files', { scope: 'files' });
      await fx.db.searchNodes('no_such_symbol_for_perf_nodes', { scope: 'nodes' });

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[perf]'));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('skipped(scope)'));
    } finally {
      if (prev === undefined) delete process.env.DEVSMIND_PERF_DEBUG;
      else process.env.DEVSMIND_PERF_DEBUG = prev;
      errSpy.mockRestore();
      fx.cleanup();
    }
  });
});
