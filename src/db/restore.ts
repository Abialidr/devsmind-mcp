import * as fs from 'fs';
import { DevMindDatabase } from './database';
import { DbNode } from './schema';

export interface RestorePlan {
  /** File exists and the symbol name still appears in it: safe to bring back. */
  restorable: DbNode[];
  /** File exists but the name is gone: really removed/renamed. Stays deprecated. */
  gone_from_file: DbNode[];
  /** File not found on this machine. Stays deprecated (may be another machine's path). */
  file_missing: DbNode[];
}

/** Last segment of a possibly qualified name (`Class.method` -> `method`). */
function symbolOf(n: DbNode): string {
  const seg = n.name.split(/[.#:]/).filter(Boolean);
  return seg.length ? seg[seg.length - 1] : n.name;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read-only. Classifies every deprecated node by direct evidence: does its file exist, and does a
 * whole-word match of its name still appear in it. Each file is read once. A plain word search is
 * approximate (a comment or string counts), so the count is "close, not exact".
 */
export function planRestore(db: DevMindDatabase): RestorePlan {
  const plan: RestorePlan = { restorable: [], gone_from_file: [], file_missing: [] };
  const byFile = new Map<string, DbNode[]>();
  for (const n of db.getAllNodes()) {
    if (n.deprecated !== 1) continue;
    const list = byFile.get(n.file_path);
    if (list) list.push(n); else byFile.set(n.file_path, [n]);
  }
  for (const [file, nodes] of byFile) {
    let text: string | null = null;
    try {
      text = fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf-8') : null;
    } catch {
      text = null;
    }
    for (const n of nodes) {
      if (text === null) { plan.file_missing.push(n); continue; }
      const name = symbolOf(n);
      const found = name.length > 0 && new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`).test(text);
      (found ? plan.restorable : plan.gone_from_file).push(n);
    }
  }
  return plan;
}

export function applyRestore(db: DevMindDatabase, plan: RestorePlan): number {
  return db.restoreNodes(plan.restorable.map(n => n.id));
}
