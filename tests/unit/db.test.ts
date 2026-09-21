import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  StaleControlError,
  acquireGeneration,
  getFrame,
  getProgram,
  publishNextFrame,
  saveProgram,
} from '../../src/lib/db';
import { adoptProgram, makeCue } from '../../src/lib/program';
import type { ControllerInfo, Cue } from '../../src/types';

const A: ControllerInfo = { id: 'ctl-A', name: '甲控制台' };
const B: ControllerInfo = { id: 'ctl-B', name: '乙控制台' };

function subtitleCue(zh: string, it: string): Cue {
  const c = makeCue('subtitle');
  c.zh = zh;
  c.it = it;
  return c;
}

describe('IndexedDB 持久状态', () => {
  let idb: IDBFactory;

  beforeEach(() => {
    // 每个用例使用全新内存 IndexedDB
    idb = new IDBFactory();
  });

  it('采用的节目单可持久化并重新读出（刷新不回退）', async () => {
    const program = adoptProgram([subtitleCue('夜深沉', 'O notte')], 1234);
    await saveProgram(program, idb);

    const reloaded = await getProgram(idb);
    expect(reloaded?.id).toBe(program.id);
    expect(reloaded?.cues).toHaveLength(1);
    expect(reloaded?.cues[0]!.zh).toBe('夜深沉');
  });

  it('接管时代次从 1 单调递增，起始帧为黑场并持久化', async () => {
    const f1 = await acquireGeneration(A, 'prog-1', 1000, idb);
    expect(f1.generation).toBe(1);
    expect(f1.seq).toBe(0);
    expect(f1.kind).toBe('blackout');
    expect(f1.controllerId).toBe('ctl-A');

    const f2 = await acquireGeneration(B, 'prog-1', 2000, idb);
    expect(f2.generation).toBe(2);
    expect(f2.controllerId).toBe('ctl-B');

    // 重开页面：getFrame 读到的是最新代次的已确认帧
    const persisted = await getFrame(idb);
    expect(persisted?.generation).toBe(2);
  });

  it('切句/黑场在同一事务中核对控制者与代次、seq 递增并落库', async () => {
    const start = await acquireGeneration(A, 'prog-1', 1000, idb);
    const cue = subtitleCue('第一句', 'Prima riga');

    const f = await publishNextFrame(
      {
        kind: 'subtitle',
        cueId: cue.id,
        cueIndex: 0,
        zh: cue.zh,
        it: cue.it,
        generation: start.generation,
        programId: 'prog-1',
        controllerId: A.id,
        controllerName: A.name,
      },
      1100,
      idb,
    );
    expect(f.seq).toBe(1);

    const black = await publishNextFrame(
      {
        kind: 'blackout',
        cueId: null,
        cueIndex: -1,
        zh: '',
        it: '',
        generation: 1,
        programId: 'prog-1',
        controllerId: A.id,
        controllerName: A.name,
      },
      1200,
      idb,
    );
    expect(black.seq).toBe(2);
    expect(black.kind).toBe('blackout');

    const persisted = await getFrame(idb);
    expect(persisted?.seq).toBe(2);
  });

  it('迟到的旧控制者发布被事务拒绝（StaleControlError），持久帧保持新代次', async () => {
    await acquireGeneration(A, 'prog-1', 1000, idb);
    // 乙接管，代次推进到 2
    const bStart = await acquireGeneration(B, 'prog-1', 2000, idb);

    await expect(
      publishNextFrame(
        {
          kind: 'subtitle',
          cueId: 'x',
          cueIndex: 0,
          zh: '甲迟到的一句',
          it: 'riga tardiva',
          generation: 1, // 旧代次
          programId: 'prog-1',
          controllerId: A.id, // 旧控制者
          controllerName: A.name,
        },
        3000,
        idb,
      ),
    ).rejects.toBeInstanceOf(StaleControlError);

    // 旧帧写入没有发生
    const persisted = await getFrame(idb);
    expect(persisted?.generation).toBe(2);
    expect(persisted?.controllerId).toBe(B.id);
    expect(persisted?.seq).toBe(bStart.seq);
  });

  it('同代次但控制者不匹配（伪造/串台）同样被拒', async () => {
    await acquireGeneration(A, 'prog-1', 1000, idb);
    await expect(
      publishNextFrame(
        {
          kind: 'blackout',
          cueId: null,
          cueIndex: -1,
          zh: '',
          it: '',
          generation: 1,
          programId: 'prog-1',
          controllerId: B.id,
          controllerName: B.name,
        },
        1100,
        idb,
      ),
    ).rejects.toBeInstanceOf(StaleControlError);
  });

  it('并发接管：代次绝不重复（同库连续事务串行化）', async () => {
    const results = await Promise.all([
      acquireGeneration(A, 'prog-1', 1, idb),
      acquireGeneration(A, 'prog-1', 2, idb),
      acquireGeneration(A, 'prog-1', 3, idb),
    ]);
    const gens = results.map((f) => f.generation).sort((x, y) => x - y);
    expect(gens).toEqual([1, 2, 3]);
    expect(new Set(gens).size).toBe(3);
  });
});
