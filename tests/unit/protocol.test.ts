import { describe, expect, it } from 'vitest';
import {
  isControllerAtLeast,
  isNewerFrame,
  shouldClearController,
} from '../../src/lib/protocol';
import type { FrameState } from '../../src/types';

function frame(generation: number, sequence: number): FrameState {
  return {
    generation,
    sequence,
    controllerId: `ctl-${generation}`,
    controllerLabel: '台',
    content: { kind: 'blackout', cueId: null, source: '', translation: '' },
    publishedAt: 0,
  };
}

describe('isNewerFrame 代次栅栏', () => {
  it('无当前画面时接受任何帧', () => {
    expect(isNewerFrame(null, frame(1, 0))).toBe(true);
  });

  it('同代次只接受更大序号', () => {
    const cur = frame(3, 5);
    expect(isNewerFrame(cur, frame(3, 6))).toBe(true);
    expect(isNewerFrame(cur, frame(3, 5))).toBe(false);
    expect(isNewerFrame(cur, frame(3, 4))).toBe(false);
  });

  it('更高代次即使序号很小也接受（接管瞬间 seq 从 0 起）', () => {
    expect(isNewerFrame(frame(2, 99), frame(3, 0))).toBe(true);
  });

  it('旧代次的迟到消息一律丢弃，哪怕序号很大', () => {
    expect(isNewerFrame(frame(3, 0), frame(2, 9999))).toBe(false);
    expect(isNewerFrame(frame(3, 10), frame(1, 10))).toBe(false);
  });
});

describe('控制者广播判定', () => {
  it('同代次心跳可刷新', () => {
    expect(isControllerAtLeast(2, 2)).toBe(true);
    expect(isControllerAtLeast(2, 3)).toBe(true);
  });

  it('旧代次心跳不能覆盖新代次', () => {
    expect(isControllerAtLeast(3, 2)).toBe(false);
  });

  it('旧代次的退场消息不能清掉新代次控制者', () => {
    expect(shouldClearController(3, 2)).toBe(false);
    expect(shouldClearController(3, 3)).toBe(true);
    expect(shouldClearController(null, 1)).toBe(false);
  });
});
