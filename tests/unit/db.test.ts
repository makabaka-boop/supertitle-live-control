import { beforeEach, describe, expect, it } from 'vitest';
import type { Cue } from '../../src/types';
import {
  _resetDatabaseForTests,
  adoptProgram,
  ControllerMismatchError,
  EmptyProgramError,
  loadFrame,
  loadPersisted,
  NoFrozenProgramError,
  publishFrame,
  saveDraft,
  startPerformance,
  StaleGenerationError,
} from '../../src/lib/db';

function cue(id: string, source = 'la', translation = '啦'): Cue {
  return { id, kind: 'subtitle', source, translation, note: '' };
}

beforeEach(async () => {
  await _resetDatabaseForTests();
});

describe('节目单冻结', () => {
  it('空节目单不能采用', async () => {
    await expect(adoptProgram([])).rejects.toBeInstanceOf(EmptyProgramError);
  });

  it('采用后再编辑草稿不影响冻结的在演版本', async () => {
    await saveDraft({
      cues: [cue('a', 'A', '甲')],
      draftRev: 1,
      updatedAt: 1,
    });
    const frozen = await adoptProgram([cue('a', 'A', '甲')]);
    expect(frozen.cues).toHaveLength(1);

    // 模拟“后续编辑”：清空并彻底改写草稿。
    await saveDraft({
      cues: [cue('b', 'B', '乙'), cue('c', 'C', '丙')],
      draftRev: 2,
      updatedAt: 2,
    });

    const persisted = await loadPersisted();
    expect(persisted.draft.cues.map((c) => c.id)).toEqual(['b', 'c']);
    expect(persisted.frozen?.cues.map((c) => c.id)).toEqual(['a']);
    // 冻结快照不受草稿对象事后突变影响（采用时是拷贝）。
    frozen.cues[0].source = 'MUTATED';
    const again = await loadPersisted();
    expect(again.frozen?.cues[0].source).toBe('A');
  });
});

describe('开演代次与初始画面', () => {
  it('没有冻结节目单不能开演', async () => {
    await expect(
      startPerformance({ id: 'x', label: '台' }),
    ).rejects.toBeInstanceOf(NoFrozenProgramError);
  });

  it('开演在同一事务内取得递增代次并写入 seq=0 画面', async () => {
    await adoptProgram([cue('a')]);
    const r1 = await startPerformance({ id: 'ctl-1', label: '甲台' });
    expect(r1.generation).toBe(1);
    expect(r1.frame.sequence).toBe(0);
    expect(r1.frame.controllerId).toBe('ctl-1');

    const r2 = await startPerformance({ id: 'ctl-2', label: '乙台' });
    expect(r2.generation).toBe(2);
    expect(r2.frame.sequence).toBe(0);

    const frame = await loadFrame();
    expect(frame?.generation).toBe(2);
  });

  it('开演初始画面可携带上一代内容（接管不闪黑）', async () => {
    await adoptProgram([cue('a', 'Solo', '独唱')]);
    const first = await startPerformance({ id: 'ctl-1', label: '甲' });
    await publishFrame({
      controllerId: 'ctl-1',
      generation: first.generation,
      content: { kind: 'subtitle', cueId: 'a', source: 'Solo', translation: '独唱' },
    });

    const second = await startPerformance(
      { id: 'ctl-2', label: '乙' },
      {
        initialContent: {
          kind: 'subtitle',
          cueId: 'a',
          source: 'Solo',
          translation: '独唱',
        },
      },
    );
    expect(second.frame.generation).toBe(2);
    expect(second.frame.sequence).toBe(0);
    expect(second.frame.content.translation).toBe('独唱');
  });
});

describe('发布画面的事务栅栏', () => {
  async function setupTwoGenerations() {
    await adoptProgram([cue('a'), cue('b')]);
    const g1 = await startPerformance({ id: 'old', label: '旧台' });
    await publishFrame({
      controllerId: 'old',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'a', source: 'A1', translation: '甲1' },
    });
    // 新控制者开第二代。
    const g2 = await startPerformance({ id: 'new', label: '新台' });
    return { g1, g2 };
  }

  it('正常发布：同事务核对控制者与代次、序号递增并持久化', async () => {
    const { g2 } = await setupTwoGenerations();
    const f1 = await publishFrame({
      controllerId: 'new',
      generation: g2.generation,
      content: { kind: 'subtitle', cueId: 'b', source: 'B1', translation: '乙1' },
    });
    expect(f1.generation).toBe(2);
    expect(f1.sequence).toBe(1);
    const stored = await loadFrame();
    expect(stored).toEqual(f1);
  });

  it('失锁旧页用旧代次发布：抛 StaleGenerationError 且画面保持新代次', async () => {
    const { g1, g2 } = await setupTwoGenerations();
    await expect(
      publishFrame({
        controllerId: 'old',
        generation: g1.generation,
        content: { kind: 'subtitle', cueId: 'a', source: 'STALE', translation: '旧' },
      }),
    ).rejects.toBeInstanceOf(StaleGenerationError);

    const stored = await loadFrame();
    expect(stored?.generation).toBe(g2.generation);
    expect(stored?.content.source).not.toBe('STALE');
  });

  it('冒充同代次但 controllerId 不符：拒绝并保持画面', async () => {
    const { g2 } = await setupTwoGenerations();
    await expect(
      publishFrame({
        controllerId: 'impostor',
        generation: g2.generation,
        content: { kind: 'blackout', cueId: null, source: '', translation: '' },
      }),
    ).rejects.toBeInstanceOf(ControllerMismatchError);
  });
});
