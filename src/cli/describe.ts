import * as path from 'path';
import { DevMindDatabase } from '../db/database';
import { resolveDevmindDir } from '../utils/config';
import { resolveLlmCredentials, sendPromptWithRetry, LlmCredentials } from './llm-client';
import { throttleRpm } from './runner';
import { validateDescription } from '../utils/tokenize';
import { safeJsonParse } from '../utils/json';
import { isEmbedderAvailable, embedTextsInt8, hashDescription } from '../db/embedder';
import { renderSyncProgress, clearSyncProgressLine } from './sync-progress';

/**
 * The one-off backfill for nodes that already exist but predate the description requirement
 * (or were created by a teammate on an older devsmind version). The GROW-AS-YOU-GO path — the
 * commit_changes gate + add_description — is what keeps new nodes described going forward;
 * this command is only for clearing an existing backlog, and is always safe to re-run: the
 * work queue is simply `WHERE description IS NULL`, so nothing here can double-describe a node
 * or lose track of progress on interruption.
 *
 * The core loop (`describePendingNodes`) is also reused as an optional Phase 3 of
 * `devsmind index --run` (see runner.ts's `--describe` flag) — `devsmind index --run`'s own
 * Phase 1 extraction never writes a description (it's LLM-extracted structure only), so its
 * nodes start out exactly as undescribed as a pre-description-requirement backlog would be, and
 * the SAME credentials already resolved for indexing can describe them immediately afterward
 * instead of requiring a separate `devsmind describe` invocation with its own --key/--provider.
 */

const BATCH_SIZE = 25;

const SYSTEM_PROMPT = 'You are documenting an existing codebase for a semantic search index. For each code entity given, write a 1-3 sentence natural-language DESCRIPTION of what it actually DOES and the domain concepts involved — using words a developer would search by later (e.g. mention "login"/"sign-in"/"authentication" together, not just whichever single term the code happens to use). NEVER restate the identifier\'s own name back as the description ("verifyCredentials" -> "verifies credentials" is rejected — it adds no new searchable vocabulary). Return ONLY a JSON object matching {"descriptions": [{"node_id": "...", "description": "..."}]} — exactly one entry per entity given, node_id copied verbatim, in the same order. No markdown fences, no extra commentary.';

interface DescribeCandidate {
  node_id: string;
  name: string;
  type: string;
  signature: string | null;
  file_path: string;
  code: string;
}

function buildUserPrompt(nodes: DescribeCandidate[]): string {
  return nodes.map(n =>
    `node_id: ${n.node_id}\nname: ${n.name}\ntype: ${n.type}\nsignature: ${n.signature || '(none)'}\nfile: ${n.file_path}\ncode:\n${n.code.slice(0, 2000)}`
  ).join('\n---\n');
}

export interface DescribeRunResult {
  /** Nodes with no description at the moment `describePendingNodes` was called. */
  pending: number;
  described: number;
  failed: number;
  skipped: number;
  embedded: number;
}

/**
 * Describes every currently-undescribed, non-deprecated node using already-resolved `creds`.
 * Shared by `handleDescribe` (which resolves creds from its own --provider/--key CLI flags) and
 * `runBackgroundIndexing`'s optional Phase 3 (which reuses the creds it already resolved for
 * extraction — same provider, same call, no separate credential setup).
 */
export async function describePendingNodes(
  db: DevMindDatabase,
  creds: LlmCredentials,
  opts: { batchSize?: number; rpm?: number; log?: (msg: string) => void } = {}
): Promise<DescribeRunResult> {
  const log = opts.log ?? console.log;
  const pending = db.getAllNodes().filter(n => !n.deprecated && !n.description);
  const result: DescribeRunResult = { pending: pending.length, described: 0, failed: 0, skipped: 0, embedded: 0 };

  if (pending.length === 0) {
    log('✅ Nothing to describe — every node already has one.');
    return result;
  }
  log(`   Pending  : ${pending.length} node(s) with no description`);

  // Checked once, not per-batch — if the optional ONNX dependency is absent this stays false for
  // the whole run and every batch just skips the embed step. Description-writing still succeeds
  // either way; an unembedded description is picked up later by `devsmind embed`.
  const embedderAvailable = await isEmbedderAvailable();
  if (!embedderAvailable) {
    log('   (semantic embedder unavailable — descriptions will be written without vectors; run "devsmind embed" later once it is)');
  }

  const batchSize = Math.max(1, opts.batchSize || BATCH_SIZE);

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const candidates: DescribeCandidate[] = [];
    for (const n of batch) {
      const latest = db.getLatestCode(n.id);
      if (!latest?.code_snapshot) { result.skipped++; continue; } // nothing to describe FROM
      candidates.push({ node_id: n.id, name: n.name, type: n.type, signature: n.signature, file_path: n.file_path, code: latest.code_snapshot });
    }
    if (candidates.length === 0) continue;

    log(`\n[${Math.min(i + batchSize, pending.length)}/${pending.length}] describing a batch of ${candidates.length}...`);

    let raw: string;
    try {
      await throttleRpm(opts.rpm);
      raw = await sendPromptWithRetry(creds, SYSTEM_PROMPT, buildUserPrompt(candidates), {
        onRetry: (msg) => log(`   ⚠ ${msg}`)
      });
    } catch (err) {
      // Per-batch failures are non-fatal — this batch's nodes stay undescribed (still NULL) and
      // get picked up again automatically on the next `devsmind describe` run. Nothing to clean
      // up, nothing lost.
      log(`   ❌ batch failed after retries (${(err as Error).message}) — skipping, safe to re-run this command later`);
      result.failed += candidates.length;
      continue;
    }

    const parsed = safeJsonParse<{ descriptions?: { node_id: string; description: string }[] }>(raw, {});
    const byId = new Map((parsed.descriptions || []).map(it => [it.node_id, it.description]));

    // Accumulated across this batch and flushed as ONE embedding call below, after the
    // description-write loop — batching matters far more for ONNX inference than it did for
    // describe's own HTTP calls, so embedding one-at-a-time inside the loop would be wasteful.
    const toEmbed: { node_id: string; description: string }[] = [];

    for (const n of candidates) {
      const description = byId.get(n.node_id);
      if (!description) {
        result.failed++;
        log(`   ⚠ no description returned for ${n.node_id}`);
        continue;
      }
      const check = validateDescription(description, n.node_id);
      if (!check.ok) {
        result.failed++;
        log(`   ⚠ rejected for ${n.node_id}: ${check.error}`);
        continue;
      }
      db.upsertNode({ id: n.node_id, type: n.type, name: n.name, file_path: n.file_path, description });
      result.described++;
      if (embedderAvailable) toEmbed.push({ node_id: n.node_id, description });
    }

    if (toEmbed.length > 0) {
      const vectors = await embedTextsInt8(toEmbed.map(t => t.description));
      if (vectors) {
        for (let j = 0; j < toEmbed.length; j++) {
          db.upsertNodeVector(toEmbed[j].node_id, vectors[j], hashDescription(toEmbed[j].description));
          result.embedded++;
        }
      } else {
        // Embedder was available a moment ago but failed mid-run — descriptions are already
        // written and safe; these nodes just fall into `devsmind embed`'s queue for later.
        log(`   ⚠ embedding failed for this batch — descriptions saved, vectors pending (run "devsmind embed" later)`);
      }
    }
  }

  log(
    `\n✅ Described ${result.described} node(s).` +
    (embedderAvailable ? ` Embedded ${result.embedded}.` : '') +
    (result.failed ? ` ${result.failed} failed or were rejected (still undescribed — re-run to retry just those).` : '') +
    (result.skipped ? ` ${result.skipped} skipped (no code snapshot on record to describe from).` : '')
  );

  return result;
}

export async function handleDescribe(opts: {
  path?: string;
  provider: 'gemini' | 'vertex' | 'ollama';
  model?: string;
  key?: string;
  url?: string;
  rpm?: number;
  batchSize?: number;
  dryRun?: boolean;
}): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);
  if (!devmindDir) {
    console.error('❌ No .devmind directory found.\n   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.');
    process.exit(1);
    return;
  }

  console.log(`🧠 DevsMind Describe — backfilling node descriptions`);
  console.log(`   Brain    : ${devmindDir}`);

  const db = new DevMindDatabase(path.join(devmindDir, 'brain.db'), { onSyncProgress: renderSyncProgress });
  clearSyncProgressLine();

  if (opts.dryRun) {
    const pending = db.getAllNodes().filter(n => !n.deprecated && !n.description);
    console.log(`   Pending  : ${pending.length} node(s) with no description`);
    console.log('   (--dry-run: listing only, no credentials needed, no LLM calls made, nothing written)');
    for (const n of pending.slice(0, 50)) console.log(`   - ${n.id}`);
    if (pending.length > 50) console.log(`   ... and ${pending.length - 50} more`);
    db.close();
    return;
  }

  // Credentials are only resolved past this point — --dry-run above never needs them at all.
  let creds;
  try {
    creds = resolveLlmCredentials({ provider: opts.provider, model: opts.model, key: opts.key, url: opts.url });
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    db.close();
    process.exit(1);
    return;
  }
  console.log(`   Provider : ${opts.provider}   Model: ${creds.model}`);

  await describePendingNodes(db, creds, { batchSize: opts.batchSize, rpm: opts.rpm });
  db.close();
}
