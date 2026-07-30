import { ExtractionCandidate, enumerateFileCandidates, listFileImports } from '../utils/ast';
import { LlmCredentials, LlmTool, LlmConversationMessage, sendConversationTurnWithRetry } from './llm-client';
import { throttleRpm } from './runner';

/**
 * Agentic node-extraction curation — the judgment half of Phase D. `enumerateFileCandidates`
 * (deterministic, no LLM) already found every candidate and split them by whether their EXISTENCE
 * is unambiguous (`isExported`). This module handles only what's left: for candidates whose
 * significance genuinely requires judgment (an unexported helper, an anonymous default, a tiny
 * inline callback), a multi-turn tool-calling agent decides keep/drop/merge/rename. Existence is
 * never delegated to the model — only significance is, which is the whole reason this is more
 * reliable than the old "dump the whole file to an LLM and hope it finds everything" extraction.
 */

export type CurationDecisionKind = 'keep' | 'drop' | 'merge' | 'rename';

export interface CurationDecision {
  qualified: string;
  decision: CurationDecisionKind;
  /** Present when `decision === 'merge'` — the candidate this one conceptually belongs to. */
  mergeInto?: string;
  /** Present when `decision === 'rename'` — the better name for this candidate. */
  renameTo?: string;
  reason?: string;
}

export interface CurationResult {
  decisions: CurationDecision[];
  /** True when the turn budget ran out before the model called `submit_decisions` — every
   * candidate defaulted to "keep" (see {@link curateAmbiguousCandidates}'s doc for why). */
  timedOut: boolean;
}

const SUBMIT_TOOL_NAME = 'submit_decisions';
const GET_IMPORTS_TOOL_NAME = 'get_file_imports';

function buildTools(): LlmTool[] {
  return [
    {
      name: GET_IMPORTS_TOOL_NAME,
      description:
        "Returns this file's own import statements (module specifier + imported name). Useful to judge whether an ambiguous candidate is a real, independently meaningful entity or just a trivial local detail — e.g. whether it mirrors something worth tracking alongside a specific imported dependency, versus pure local plumbing.",
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: SUBMIT_TOOL_NAME,
      description:
        'REQUIRED — call this exactly once, when you have a decision for every candidate, to finish the task. This is the ONLY way to finish; do not stop without calling it.',
      parameters: {
        type: 'object',
        properties: {
          decisions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                qualified: { type: 'string', description: 'The candidate\'s "qualified" name, copied exactly as given.' },
                decision: { type: 'string', enum: ['keep', 'drop', 'merge', 'rename'] },
                merge_into: { type: 'string', description: 'Required when decision is "merge" — the qualified name of the candidate this one belongs to.' },
                rename_to: { type: 'string', description: 'Required when decision is "rename" — the better name for this candidate.' },
                reason: { type: 'string', description: 'One short sentence: why.' }
              },
              required: ['qualified', 'decision']
            }
          }
        },
        required: ['decisions']
      }
    }
  ];
}

function buildSystemPrompt(): string {
  return [
    'You are curating a list of code-graph node CANDIDATES for one source file.',
    "These candidates were found deterministically by parsing the file's AST — every one of them genuinely exists in the code, at the exact line numbers given. Nothing about their EXISTENCE is in question here.",
    '',
    'Your ONLY job is judgment. For EACH candidate, decide:',
    '- "keep" — a real, independently meaningful entity worth its own node.',
    '- "drop" — trivial noise (e.g. a tiny inline callback, a throwaway local) not worth tracking on its own.',
    '- "merge" — this is really part of another candidate\'s concept, not a distinct entity (give merge_into).',
    "- \"rename\" — the extractor's name is wrong, unclear, or anonymous and you have a genuinely better one (give rename_to).",
    '',
    `Call ${GET_IMPORTS_TOOL_NAME} if the file's imports would help you judge significance — as many times as you like, though it never changes between calls.`,
    `When you have a decision for EVERY candidate, call ${SUBMIT_TOOL_NAME} exactly once with the full list. Keep any "reason" to one short sentence. Do not respond with plain text instead of a tool call.`
  ].join('\n');
}

function buildInitialUserMessage(filePath: string, candidates: ExtractionCandidate[]): string {
  const blocks = candidates.map(c =>
    `- qualified: "${c.qualified}"\n  type: ${c.type}\n  lines: ${c.startLine}-${c.endLine}\n  code:\n${c.codeSnapshot.split('\n').map(l => '    ' + l).join('\n')}`
  );
  return `File: ${filePath}\n\n${candidates.length} candidate(s) to curate:\n\n${blocks.join('\n\n')}`;
}

function parseDecisions(args: Record<string, unknown>, candidates: ExtractionCandidate[]): CurationDecision[] {
  const raw = Array.isArray((args as { decisions?: unknown }).decisions) ? (args as { decisions: unknown[] }).decisions : [];
  const validQualified = new Set(candidates.map(c => c.qualified));
  const decisions: CurationDecision[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const d = entry as Record<string, unknown>;
    if (!d || typeof d.qualified !== 'string' || !validQualified.has(d.qualified)) continue;
    if (seen.has(d.qualified)) continue; // one decision per candidate — a duplicate is ignored
    seen.add(d.qualified);
    const decisionKind: CurationDecisionKind =
      d.decision === 'drop' || d.decision === 'merge' || d.decision === 'rename' ? d.decision : 'keep';
    decisions.push({
      qualified: d.qualified,
      decision: decisionKind,
      mergeInto: typeof d.merge_into === 'string' ? d.merge_into : undefined,
      renameTo: typeof d.rename_to === 'string' ? d.rename_to : undefined,
      reason: typeof d.reason === 'string' ? d.reason : undefined
    });
  }

  // Any candidate the model never mentioned still needs a decision — same conservative default
  // as a turn-budget timeout (see curateAmbiguousCandidates): keep, not silently drop.
  for (const c of candidates) {
    if (!seen.has(c.qualified)) {
      decisions.push({ qualified: c.qualified, decision: 'keep', reason: 'not mentioned by the model — conservative default' });
    }
  }
  return decisions;
}

/**
 * Runs the agentic curation loop over one file's AMBIGUOUS candidates only (the `isExported:false`
 * subset of `enumerateFileCandidates` — the caller is responsible for that split, see
 * {@link extractFileWithCuration}). Multi-turn: the model may call `get_file_imports` any number
 * of times before it must call `submit_decisions` to finish. `opts.onTurn` receives one line per
 * model turn — nothing about this loop happens silently.
 *
 * If the turn budget is exhausted without a `submit_decisions` call, every candidate defaults to
 * "keep" — silently dropping a real candidate is a worse failure than over-including one, and
 * everything reaching this function already passed the deterministic auto-accept gate, so "keep,
 * unreviewed" is the safe fallback, not a crash or a lost node.
 */
export async function curateAmbiguousCandidates(
  creds: LlmCredentials,
  filePath: string,
  candidates: ExtractionCandidate[],
  opts: { maxTurns?: number; rpm?: number; onTurn?: (line: string) => void } = {}
): Promise<CurationResult> {
  if (candidates.length === 0) return { decisions: [], timedOut: false };

  const maxTurns = opts.maxTurns ?? 4;
  const tools = buildTools();
  const systemPrompt = buildSystemPrompt();
  const messages: LlmConversationMessage[] = [{ role: 'user', content: buildInitialUserMessage(filePath, candidates) }];
  const log = opts.onTurn ?? (() => {});

  for (let turn = 1; turn <= maxTurns; turn++) {
    await throttleRpm(opts.rpm);
    const result = await sendConversationTurnWithRetry(creds, systemPrompt, messages, tools, {
      onRetry: (m) => log(`  ⚠ ${m}`)
    });

    const submitCall = result.toolCalls.find(tc => tc.name === SUBMIT_TOOL_NAME);
    if (submitCall) {
      const decisions = parseDecisions(submitCall.args, candidates);
      log(`  ✓ turn ${turn}: ${SUBMIT_TOOL_NAME} — ${decisions.length} decision(s)`);
      return { decisions, timedOut: false };
    }

    const importsCall = result.toolCalls.find(tc => tc.name === GET_IMPORTS_TOOL_NAME);
    if (importsCall) {
      log(`  → turn ${turn}: ${GET_IMPORTS_TOOL_NAME}`);
      messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
      messages.push({
        role: 'tool',
        toolCallId: importsCall.id,
        toolName: GET_IMPORTS_TOOL_NAME,
        content: JSON.stringify(listFileImports(filePath))
      });
      continue;
    }

    // No recognized tool call this turn — nudge once rather than loop silently on a model that
    // isn't cooperating; if it still won't call a tool, the turn budget above ends this cleanly.
    log(`  ? turn ${turn}: no tool call — nudging`);
    messages.push({ role: 'assistant', content: result.text, toolCalls: [] });
    messages.push({
      role: 'user',
      content: `You must call ${SUBMIT_TOOL_NAME} to finish (or ${GET_IMPORTS_TOOL_NAME} first if you need it). Do not respond with plain text.`
    });
  }

  log(`  ⚠ turn budget (${maxTurns}) exhausted — defaulting all ${candidates.length} candidate(s) to "keep"`);
  return {
    decisions: candidates.map(c => ({ qualified: c.qualified, decision: 'keep' as const, reason: 'curation turn budget exhausted — conservative default' })),
    timedOut: true
  };
}

/** The shape `runBackgroundIndexing`/`runBackgroundReindexing` already consume from the old
 * `extractNodesFromCode` — matched exactly so wiring this in is a drop-in call-site swap. */
export interface CuratedExtractionResult {
  nodes: { node_id: string; name: string; type: string; signature?: string; code_snapshot: string }[];
}

/**
 * The full Phase D per-file extraction: deterministic enumeration + auto-accept for exported
 * candidates (zero LLM turns), agentic curation only for the ambiguous remainder. This is the
 * cost control the whole design rests on — on a typical file most candidates ARE exported, so most
 * files touch the LLM only for a handful of borderline cases, or not at all.
 */
export async function extractFileWithCuration(
  creds: LlmCredentials,
  filePath: string,
  opts: { maxTurns?: number; rpm?: number; onLog?: (line: string) => void } = {}
): Promise<CuratedExtractionResult> {
  const log = opts.onLog ?? (() => {});
  const candidates = enumerateFileCandidates(filePath);
  const exported = candidates.filter(c => c.isExported);
  const ambiguous = candidates.filter(c => !c.isExported);

  log(`  ${exported.length} exported (auto-accepted, 0 LLM turns), ${ambiguous.length} ambiguous`);

  const nodes: CuratedExtractionResult['nodes'] = exported.map(c => ({
    node_id: c.qualified,
    name: c.name,
    type: c.type,
    signature: c.signature ?? undefined,
    code_snapshot: c.codeSnapshot
  }));

  if (ambiguous.length === 0) return { nodes };

  const result = await curateAmbiguousCandidates(creds, filePath, ambiguous, {
    maxTurns: opts.maxTurns,
    rpm: opts.rpm,
    onTurn: log
  });
  const byQualified = new Map(ambiguous.map(c => [c.qualified, c]));

  for (const d of result.decisions) {
    const c = byQualified.get(d.qualified);
    if (!c) continue;
    // "merge" folds this candidate's SIGNIFICANCE into its target conceptually — it does not
    // become a separate node. The merge target (if it's also a real candidate) is handled by its
    // own decision entry; this candidate's code simply isn't extracted as its own node.
    if (d.decision === 'drop' || d.decision === 'merge') continue;
    const name = d.decision === 'rename' && d.renameTo ? d.renameTo : c.name;
    const nodeId = d.decision === 'rename' && d.renameTo ? d.renameTo : c.qualified;
    nodes.push({ node_id: nodeId, name, type: c.type, signature: c.signature ?? undefined, code_snapshot: c.codeSnapshot });
  }

  return { nodes };
}
