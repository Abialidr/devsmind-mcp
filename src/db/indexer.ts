import * as fs from 'fs';
import * as path from 'path';

export interface IndexScratchpad {
  status: 'in_progress' | 'complete';
  phase: 1 | 2;
  started_at: string;
  updated_at: string;
  files_done: number;
  files_total: number;
  nodes_created: number;
  nodes_done: number;
  nodes_total: number;
  connections_created: number;
  last_file_indexed: string | null;
  repos_done: string[];
  current_repo: string | null;
}

const SCRATCHPAD_FILE = 'index_scratchpad.json';

function scratchpadPath(devmindPath: string): string {
  return path.join(path.resolve(devmindPath), SCRATCHPAD_FILE);
}

export function readScratchpad(devmindPath: string): IndexScratchpad | null {
  const p = scratchpadPath(devmindPath);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as IndexScratchpad;
  } catch {
    return null;
  }
}

export function writeScratchpad(devmindPath: string, data: IndexScratchpad): void {
  const p = scratchpadPath(devmindPath);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

export function createScratchpad(devmindPath: string, filesTotal: number): IndexScratchpad {
  const now = new Date().toISOString();
  const pad: IndexScratchpad = {
    status: 'in_progress',
    phase: 1,
    started_at: now,
    updated_at: now,
    files_done: 0,
    files_total: filesTotal,
    nodes_created: 0,
    nodes_done: 0,
    nodes_total: 0,
    connections_created: 0,
    last_file_indexed: null,
    repos_done: [],
    current_repo: null
  };
  writeScratchpad(devmindPath, pad);
  return pad;
}

export function updateScratchpad(
  devmindPath: string,
  patch: Partial<Omit<IndexScratchpad, 'started_at' | 'status'>>
): IndexScratchpad {
  const existing = readScratchpad(devmindPath);
  if (!existing) throw new Error('No indexing session found. Call index_start first.');
  const updated: IndexScratchpad = {
    ...existing,
    ...patch,
    updated_at: new Date().toISOString()
  };
  writeScratchpad(devmindPath, updated);
  return updated;
}

export function completeScratchpad(devmindPath: string): IndexScratchpad {
  const existing = readScratchpad(devmindPath);
  if (!existing) throw new Error('No indexing session found. Call index_start first.');
  const completed: IndexScratchpad = {
    ...existing,
    status: 'complete',
    updated_at: new Date().toISOString()
  };
  writeScratchpad(devmindPath, completed);
  return completed;
}
