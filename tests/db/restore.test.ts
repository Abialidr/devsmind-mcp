import * as fs from 'fs';
import { makeFixture, repoFile } from '../helpers/fixture';
import { planRestore, applyRestore } from '../../src/db/restore';

describe('planRestore / applyRestore (src/db/restore.ts)', () => {
  it('restores only deprecated nodes whose name is still in an existing file', () => {
    const fx = makeFixture();
    try {
      const file = repoFile(fx, 'foo.ts'); // contains greet
      fx.db.upsertNode({ id: 'live', type: 'function', name: 'greet', file_path: file });
      fx.db.upsertNode({ id: 'gone', type: 'function', name: 'vanished', file_path: file });
      fx.db.upsertNode({ id: 'missing', type: 'function', name: 'greet', file_path: repoFile(fx, 'nope.ts') });
      fx.db.upsertNode({ id: 'active', type: 'function', name: 'format', file_path: file });
      for (const id of ['live', 'gone', 'missing']) fx.db.deprecateNode(id);

      const plan = planRestore(fx.db);
      expect(plan.restorable.map(n => n.id)).toEqual(['live']);
      expect(plan.gone_from_file.map(n => n.id)).toEqual(['gone']);
      expect(plan.file_missing.map(n => n.id)).toEqual(['missing']);

      expect(applyRestore(fx.db, plan)).toBe(1);
      const byId = new Map(fx.db.getAllNodes().map(n => [n.id, n.deprecated]));
      expect(byId.get('live')).toBe(0);
      expect(byId.get('gone')).toBe(1);
      expect(byId.get('missing')).toBe(1);
      expect(byId.get('active')).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('matches whole words only and qualified names by their last segment', () => {
    const fx = makeFixture();
    try {
      const file = repoFile(fx, 'foo.ts');
      fs.writeFileSync(file, 'export class A { run() {} }\nconst greeting = 1;\n');
      fx.db.upsertNode({ id: 'm', type: 'method', name: 'A.run', file_path: file });
      fx.db.upsertNode({ id: 'sub', type: 'function', name: 'greet', file_path: file }); // only inside "greeting"
      fx.db.deprecateNode('m');
      fx.db.deprecateNode('sub');
      const plan = planRestore(fx.db);
      expect(plan.restorable.map(n => n.id)).toEqual(['m']);
      expect(plan.gone_from_file.map(n => n.id)).toEqual(['sub']);
    } finally {
      fx.cleanup();
    }
  });
});

import { runAnalysis } from '../../src/db/analyze';

describe('runAnalysis one-time repair of wrongly deprecated nodes', () => {
  it('reports without --fix, restores with --fix, and never revives again afterwards', () => {
    const fx = makeFixture();
    try {
      const file = repoFile(fx, 'foo.ts');
      fx.db.upsertNode({ id: 'live', type: 'function', name: 'greet', file_path: file });
      fx.db.deprecateNode('live');

      const preview = runAnalysis(fx.db, fx.root, { fix: false });
      expect(preview.summary.wrongly_deprecated).toBe(1);
      expect(fx.db.getAllNodes().find(n => n.id === 'live')!.deprecated).toBe(1);

      runAnalysis(fx.db, fx.root, { fix: true });
      expect(fx.db.getAllNodes().find(n => n.id === 'live')!.deprecated).toBe(0);

      // an agent deprecates it on purpose later: a second analyze must NOT revive it
      fx.db.deprecateNode('live');
      const again = runAnalysis(fx.db, fx.root, { fix: true });
      expect(again.summary.wrongly_deprecated).toBe(0);
      expect(fx.db.getAllNodes().find(n => n.id === 'live')!.deprecated).toBe(1);
    } finally {
      fx.cleanup();
    }
  });
});
