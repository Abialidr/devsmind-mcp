import * as path from 'path';
import { DevMindDatabase } from '../db/database';
import { resolveDevmindDir } from '../utils/config';
import { isEmbedderAvailable, embedTextsInt8, hashDescription } from '../db/embedder';
import { renderSyncProgress, clearSyncProgressLine } from './sync-progress';

/**
 * The one-off (and re-runnable) backfill that computes vectors for every described node that
 * doesn't have one yet, or whose vector is stale. Fully local and offline — no `--provider`,
 * `--key`, or `--rpm` like `describe` has, because inference is on-device: no credentials, no
 * rate limit. Safe to re-run any time; the work queue (`getNodesNeedingEmbedding`) is naturally
 * idempotent — a node already carrying a fresh vector for the current model just isn't selected.
 */

const BATCH_SIZE = 32;

export async function handleEmbed(opts: {
  path?: string;
  batchSize?: number;
  dryRun?: boolean;
  force?: boolean;
}): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);
  if (!devmindDir) {
    console.error('❌ No .devmind directory found.\n   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.');
    process.exit(1);
    return;
  }

  console.log(`🧠 DevsMind Embed — computing semantic vectors`);
  console.log(`   Brain    : ${devmindDir}`);

  const db = new DevMindDatabase(path.join(devmindDir, 'brain.db'), { onSyncProgress: renderSyncProgress });
  clearSyncProgressLine();
  const pending = db.getNodesNeedingEmbedding(!!opts.force);

  console.log(`   Pending  : ${pending.length} node(s) need${opts.force ? ' (--force: re-embedding all described nodes)' : ' a vector'}`);

  if (pending.length === 0) {
    console.log('✅ Nothing to embed — every described node already has a current vector.');
    db.close();
    return;
  }

  if (opts.dryRun) {
    console.log('   (--dry-run: listing only, no inference run, nothing written)');
    for (const n of pending.slice(0, 50)) console.log(`   - ${n.id}`);
    if (pending.length > 50) console.log(`   ... and ${pending.length - 50} more`);
    db.close();
    return;
  }

  const available = await isEmbedderAvailable();
  if (!available) {
    console.error(
      '❌ The local embedding model is unavailable — either the optional "onnxruntime-node"\n' +
      '   dependency failed to install for this platform, or the vendored model files are\n' +
      '   missing. Semantic search will still fall back to keyword (BM25) search without it.'
    );
    db.close();
    process.exit(1);
    return;
  }

  const batchSize = Math.max(1, opts.batchSize || BATCH_SIZE);
  let embedded = 0, failed = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    console.log(`\n[${Math.min(i + batchSize, pending.length)}/${pending.length}] embedding a batch of ${batch.length}...`);

    const vectors = await embedTextsInt8(batch.map(n => n.description as string));
    if (!vectors) {
      // The embedder was available a moment ago but failed mid-run (rare) — this batch's nodes
      // stay in the queue (no vector was written) and get retried on the next `devsmind embed`.
      console.log(`   ❌ batch failed — skipping, safe to re-run this command later`);
      failed += batch.length;
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const node = batch[j];
      db.upsertNodeVector(node.id, vectors[j], hashDescription(node.description as string));
      embedded++;
    }
  }

  console.log(
    `\n✅ Embedded ${embedded} node(s).` +
    (failed ? ` ${failed} failed (still pending — re-run this command to retry just those).` : '')
  );
  db.close();
}
