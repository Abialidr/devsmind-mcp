import { makeFixture } from '../helpers/fixture';
import { DevMindDatabase } from '../../src/db/database';
import {
  tokenizeWorkflowField, DEFAULT_WORKFLOW_FIELD_WEIGHTS, scoreCandidate, FieldMatch, WorkflowTokenField
} from '../../src/db/search-index';

/** Raw access to the live better-sqlite3 connection — `db` is `private` at the TS level only. */
function raw(db: DevMindDatabase) {
  return (db as any).db as import('better-sqlite3').Database;
}

describe('tokenizeWorkflowField', () => {
  it('returns [] for null/undefined/empty text', () => {
    expect(tokenizeWorkflowField(null, 'name')).toEqual([]);
    expect(tokenizeWorkflowField(undefined, 'description')).toEqual([]);
    expect(tokenizeWorkflowField('', 'summary')).toEqual([]);
  });

  it('dedupes and counts tf correctly', () => {
    const rows = tokenizeWorkflowField('payout payout stripe', 'summary');
    const payout = rows.find(r => r.token === 'payout');
    expect(payout?.tf).toBe(2);
    expect(rows.every(r => r.field === 'summary')).toBe(true);
  });

  it('always uses the natural-language tokenizer, never the identifier splitter', () => {
    // tokenizeIdentifier would split "verifyCredentials" into ["verify", "credentials"] via the
    // camelCase boundary; tokenizeText does not — it only splits on non-alphanumeric characters.
    // Both fields here should produce the SAME single-word-collapsed-together token, proving no
    // identifier branch leaked in the way tokenizeNodeField has for 'identifier'/'path'.
    const rows = tokenizeWorkflowField('verifyCredentials', 'name');
    expect(rows.map(r => r.token)).not.toContain('verify');
    expect(rows.map(r => r.token)).not.toContain('credentials');
  });
});

describe('DEFAULT_WORKFLOW_FIELD_WEIGHTS', () => {
  it('is exactly the documented weight object', () => {
    expect(DEFAULT_WORKFLOW_FIELD_WEIGHTS).toEqual({
      name: 4,
      description: 3.5,
      summary: 2.5,
      reasoning: 1.5
    });
  });
});

describe('scoreCandidate — generic reuse with WorkflowTokenField', () => {
  it('orders weight contribution name > description > summary > reasoning, tf/docFreq/totalNodes held equal', () => {
    const base = { tf: 3, docFreq: 2, totalNodes: 20 };
    const nameScore = scoreCandidate<WorkflowTokenField>([{ field: 'name', ...base }], DEFAULT_WORKFLOW_FIELD_WEIGHTS);
    const descScore = scoreCandidate<WorkflowTokenField>([{ field: 'description', ...base }], DEFAULT_WORKFLOW_FIELD_WEIGHTS);
    const summaryScore = scoreCandidate<WorkflowTokenField>([{ field: 'summary', ...base }], DEFAULT_WORKFLOW_FIELD_WEIGHTS);
    const reasoningScore = scoreCandidate<WorkflowTokenField>([{ field: 'reasoning', ...base }], DEFAULT_WORKFLOW_FIELD_WEIGHTS);
    expect(nameScore).toBeGreaterThan(descScore);
    expect(descScore).toBeGreaterThan(summaryScore);
    expect(summaryScore).toBeGreaterThan(reasoningScore);
  });
});

describe('DevMindDatabase.rankWorkflows', () => {
  it('matches on name', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wallet = fx.db.createWorkflow('Wallet Integration', 'Stripe payouts');
      fx.db.createWorkflow('Search Revamp', 'BM25 plus vectors');
      const result = fx.db.rankWorkflows('wallet');
      expect(result.workflows.map(w => w.id)).toEqual([wallet.id]);
      expect(result.total).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  it('matches on description only (word appears in no workflow name)', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const search = fx.db.createWorkflow('Search Revamp', 'BM25 plus vectors');
      fx.db.createWorkflow('Wallet Integration', 'Stripe payouts');
      const result = fx.db.rankWorkflows('vectors');
      expect(result.workflows.map(w => w.id)).toEqual([search.id]);
    } finally {
      fx.cleanup();
    }
  });

  it('matches on a STEP summary — the core new capability the old LIKE version never had', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Checkout Flow', 'Improve checkout');
      fx.db.createWorkflow('Unrelated', 'nothing to do with payments');
      fx.db.addWorkflowStep(wf.id, { summary: 'Fixed the Stripe webhook retry timing bug' });

      const result = fx.db.rankWorkflows('webhook retry');
      expect(result.workflows.map(w => w.id)).toEqual([wf.id]);
    } finally {
      fx.cleanup();
    }
  });

  it('matches on a STEP reasoning field', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Checkout Flow', 'Improve checkout');
      fx.db.createWorkflow('Unrelated', 'nothing to do with payments');
      fx.db.addWorkflowStep(wf.id, { summary: 'did a thing', reasoning: 'Evaluated Razorpay, no split settlements support, going with Stripe instead' });

      const result = fx.db.rankWorkflows('razorpay settlements');
      expect(result.workflows.map(w => w.id)).toEqual([wf.id]);
    } finally {
      fx.cleanup();
    }
  });

  it('tf accumulates across steps: a word in 3 different summaries scores higher than the same word in 1', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const heavy = fx.db.createWorkflow('Heavy Mentions', 'x');
      fx.db.addWorkflowStep(heavy.id, { summary: 'refactored the throttle logic' });
      fx.db.addWorkflowStep(heavy.id, { summary: 'more throttle fixes here' });
      fx.db.addWorkflowStep(heavy.id, { summary: 'final throttle cleanup pass' });

      const light = fx.db.createWorkflow('Light Mention', 'y');
      fx.db.addWorkflowStep(light.id, { summary: 'refactored the throttle logic once' });

      // A third, unrelated workflow raises totalWorkflows so "throttle"'s IDF (driven by
      // docFreq/totalWorkflows) is high enough for BOTH candidates to clear
      // MIN_WORKFLOW_BM25_SCORE — with only 2 workflows in the corpus, "throttle" appearing in
      // both is not rare enough for the single-mention case to pass the noise floor at all,
      // which would make this test about the floor rather than about tf accumulation.
      fx.db.createWorkflow('Completely Unrelated', 'nothing about throttling at all');

      const result = fx.db.rankWorkflows('throttle');
      const heavyScore = result.workflows.find(w => w.id === heavy.id)!.score;
      const lightScore = result.workflows.find(w => w.id === light.id)!.score;
      expect(heavyScore).toBeGreaterThan(lightScore);
    } finally {
      fx.cleanup();
    }
  });

  it('stems across the query/document boundary: "logging" matches step text "logged in"', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Auth Flow', 'x');
      fx.db.createWorkflow('Unrelated Flow', 'y');
      fx.db.addWorkflowStep(wf.id, { summary: 'Fixed a bug where the user was never actually logged in correctly' });

      const result = fx.db.rankWorkflows('logging in bug');
      expect(result.workflows.map(w => w.id)).toContain(wf.id);
    } finally {
      fx.cleanup();
    }
  });

  it('a plain substring that is NOT a real token match no longer matches (LIKE-style partial matching is gone)', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      fx.db.createWorkflow('Wallet Integration', 'Stripe payouts');
      // "wall" used to match via LIKE '%wall%'; token-based matching requires the whole token.
      const result = fx.db.rankWorkflows('wall');
      expect(result.workflows).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('total equals workflows.length exactly, consistent with an externally-sliced page', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      for (let i = 0; i < 5; i++) {
        const wf = fx.db.createWorkflow(`Payment Flow ${i}`, 'handles payments');
        fx.db.addWorkflowStep(wf.id, { summary: 'worked on payments today' });
      }
      const result = fx.db.rankWorkflows('payments');
      const page = result.workflows.slice(0, 2);
      expect(result.total).toBe(result.workflows.length);
      expect(page.length).toBeLessThanOrEqual(result.total);
    } finally {
      fx.cleanup();
    }
  });

  it('excludes archived workflows by default even as a top match; includes them when includeArchived is true', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Payments Overhaul', 'rework the payments pipeline');
      fx.db.setWorkflowArchived(wf.id, true);

      expect(fx.db.rankWorkflows('payments').workflows).toEqual([]);
      const withArchived = fx.db.rankWorkflows('payments', { includeArchived: true });
      expect(withArchived.workflows.map(w => w.id)).toEqual([wf.id]);
    } finally {
      fx.cleanup();
    }
  });

  it('empty/whitespace query falls back to newest-touched-first, matched_terms/matched_steps empty, total equals plain count', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf1 = fx.db.createWorkflow('First', 'x');
      const wf2 = fx.db.createWorkflow('Second', 'y');

      const empty = fx.db.rankWorkflows('');
      const whitespace = fx.db.rankWorkflows('   ');
      expect(empty.workflows.map(w => w.id)).toEqual([wf2.id, wf1.id]); // newest-touched first
      expect(whitespace.workflows.map(w => w.id)).toEqual([wf2.id, wf1.id]);
      expect(empty.workflows.every(w => w.matched_terms.length === 0 && w.matched_steps.length === 0)).toBe(true);
      expect(empty.total).toBe(fx.db.countWorkflows());
    } finally {
      fx.cleanup();
    }
  });

  it('a query that tokenizes to only stopwords behaves identically to an empty query', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Only Workflow', 'x');
      const result = fx.db.rankWorkflows('the a of');
      expect(result.workflows.map(w => w.id)).toEqual([wf.id]);
      expect(result.total).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  it('matched_steps returns correct steps, best-match-first, capped at 3, for a workflow with more than 3 matching steps', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Big Workflow', 'x');
      fx.db.addWorkflowStep(wf.id, { summary: 'refund step one' });
      fx.db.addWorkflowStep(wf.id, { summary: 'refund step two' });
      fx.db.addWorkflowStep(wf.id, { summary: 'refund step three' });
      fx.db.addWorkflowStep(wf.id, { summary: 'refund step four, mentions refund twice: refund' });

      const result = fx.db.rankWorkflows('refund');
      const match = result.workflows.find(w => w.id === wf.id)!;
      expect(match.matched_steps.length).toBe(3);
      // The step mentioning "refund" twice matches only 1 DISTINCT query token either way (there
      // is only one query token here), so ties break by step_index ascending — earliest first.
      expect(match.matched_steps[0].step_index).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  it('matched_steps is [] when the match came only from name/description, no individually-matching step', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Loyalty Program', 'Points and rewards system');
      fx.db.addWorkflowStep(wf.id, { summary: 'unrelated step about something else entirely' });

      const result = fx.db.rankWorkflows('loyalty');
      const match = result.workflows.find(w => w.id === wf.id)!;
      expect(match.matched_steps).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('coverage floor: a workflow sharing exactly one distinct token with a multi-token query is rejected', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      // Query tokenizes to 3 distinct tokens (zebra, giraffe, elephant); this workflow shares
      // only "elephant" — coverage floor requires >= 2 distinct matched tokens for a multi-token
      // query, so a single shared word must not be enough on its own.
      const wf = fx.db.createWorkflow('Migration Project', 'a workflow about elephant migration only');
      const result = fx.db.rankWorkflows('zebra giraffe elephant');
      expect(result.workflows.map(w => w.id)).not.toContain(wf.id);
    } finally {
      fx.cleanup();
    }
  });

  it('a workflow with one rare, weighted-field hit still passes if its score clears the floor', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Xylophone Integration', 'a distinctive rare word appears here');
      const result = fx.db.rankWorkflows('xylophone');
      expect(result.workflows.map(w => w.id)).toEqual([wf.id]);
    } finally {
      fx.cleanup();
    }
  });

  it('score floor: a workflow clearing minCoverage but not MIN_WORKFLOW_BM25_SCORE is rejected', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      // Both query tokens land only in the lowest-weighted field (reasoning) and are common
      // across most of the corpus (high docFreq relative to totalWorkflows) — clears the
      // 2-distinct-token coverage floor, but IDF is too weak for the summed score to clear
      // MIN_WORKFLOW_BM25_SCORE. One workflow lacks both tokens entirely, to keep the corpus
      // realistic and confirm it's correctly excluded from the ranked set for an unrelated reason.
      const commonIds: string[] = [];
      for (let i = 0; i < 9; i++) {
        const wf = fx.db.createWorkflow(`Common Workflow ${i}`, 'x');
        fx.db.addWorkflowStep(wf.id, { summary: 'did work', reasoning: 'considered alpha and beta approaches here' });
        commonIds.push(wf.id);
      }
      fx.db.createWorkflow('Different Workflow', 'y');

      const result = fx.db.rankWorkflows('alpha beta');
      expect(result.workflows.map(w => w.id)).not.toEqual(expect.arrayContaining(commonIds));
    } finally {
      fx.cleanup();
    }
  });

  it('detects a NEW step added after the index was last built — fingerprint correctly triggers a rebuild', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Growing Workflow', 'x');
      // Force an initial index build with no matching content.
      expect(fx.db.rankWorkflows('teleportation').workflows).toEqual([]);

      fx.db.addWorkflowStep(wf.id, { summary: 'implemented teleportation feature flag' });

      const result = fx.db.rankWorkflows('teleportation');
      expect(result.workflows.map(w => w.id)).toEqual([wf.id]);
    } finally {
      fx.cleanup();
    }
  });

  it('workflowSearchIndexFingerprint changes on rename, description change, step add, and step reasoning change; stable across a no-op', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const fp = () => (fx.db as any).workflowSearchIndexFingerprint() as string;
      const wf = fx.db.createWorkflow('Original Name', 'Original description');
      const afterCreate = fp();

      // no-op: calling the fingerprint fn again with nothing changed must be stable
      expect(fp()).toBe(afterCreate);

      raw(fx.db).prepare('UPDATE workflows SET name = ? WHERE id = ?').run('Renamed', wf.id);
      const afterRename = fp();
      expect(afterRename).not.toBe(afterCreate);

      // Deliberately a different LENGTH from the original description, not just different text —
      // the fingerprint is a text-length sum, not a content hash, so a same-length edit is a
      // known, accepted blind spot (identical to the node-side fingerprint's own tradeoff).
      raw(fx.db).prepare('UPDATE workflows SET description = ? WHERE id = ?').run('A completely different and longer description', wf.id);
      const afterDescChange = fp();
      expect(afterDescChange).not.toBe(afterRename);

      const step = fx.db.addWorkflowStep(wf.id, { summary: 'a step' });
      const afterStepAdd = fp();
      expect(afterStepAdd).not.toBe(afterDescChange);

      raw(fx.db).prepare('UPDATE workflow_steps SET reasoning = ? WHERE id = ?').run('some reasoning', step.id);
      const afterReasoningChange = fp();
      expect(afterReasoningChange).not.toBe(afterStepAdd);
    } finally {
      fx.cleanup();
    }
  });
});

describe('rankWorkflows — coverage-gate branches', () => {
  it('empty corpus returns { workflows: [], total: 0 } without throwing', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      expect(() => fx.db.rankWorkflows('anything')).not.toThrow();
      expect(fx.db.rankWorkflows('anything')).toEqual({ workflows: [], total: 0 });
    } finally {
      fx.cleanup();
    }
  });

  it('a workflow whose steps all have NULL reasoning still indexes correctly via its summary', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('No Reasoning Workflow', 'x');
      fx.db.addWorkflowStep(wf.id, { summary: 'a distinctive summary word gorgonzola' });
      const result = fx.db.rankWorkflows('gorgonzola');
      expect(result.workflows.map(w => w.id)).toEqual([wf.id]);
    } finally {
      fx.cleanup();
    }
  });

  it('fingerprint COALESCE fix: a NULL-reasoning step still contributes its summary length to the fingerprint', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const fp = () => (fx.db as any).workflowSearchIndexFingerprint() as string;
      const wfA = fx.db.createWorkflow('A', 'x');
      fx.db.addWorkflowStep(wfA.id, { summary: 'short' }); // reasoning stays NULL
      const fpShort = fp();

      const wfB = fx.db.createWorkflow('B', 'x');
      fx.db.addWorkflowStep(wfB.id, { summary: 'a much longer summary text than the other one' }); // reasoning stays NULL
      const fpLong = fp();

      expect(fpLong).not.toBe(fpShort);
    } finally {
      fx.cleanup();
    }
  });

  it('attachMatchedSteps handles a step with reasoning: null via the tokenizeText fallback', () => {
    const fx = makeFixture({ skipDefaultFiles: true });
    try {
      const wf = fx.db.createWorkflow('Fallback Workflow', 'x');
      fx.db.addWorkflowStep(wf.id, { summary: 'mentions marmalade specifically' }); // no reasoning
      const result = fx.db.rankWorkflows('marmalade');
      const match = result.workflows.find(w => w.id === wf.id)!;
      expect(match.matched_steps.length).toBe(1);
    } finally {
      fx.cleanup();
    }
  });
});
