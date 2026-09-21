// 纯函数：投影页的代次栅栏与消息判定，便于单元测试。

import type { FrameState } from '../types';

/**
 * 只接受更高代次，或同代次更大序号。
 * 同帧重放（相等）幂等忽略；旧代次 / 同代次旧序号一律丢弃，
 * 这样失锁旧页的迟到消息永远无法覆盖新代次确认的画面。
 */
export function isNewerFrame(
  current: FrameState | null,
  incoming: FrameState,
): boolean {
  if (!current) return true;
  if (incoming.generation !== current.generation) {
    return incoming.generation > current.generation;
  }
  return incoming.sequence > current.sequence;
}

/** 控制者广播的比较规则：新代次覆盖；同代次刷新心跳；旧代次忽略。 */
export function isControllerAtLeast(
  currentGen: number | null,
  incomingGen: number,
): boolean {
  if (currentGen === null) return true;
  return incomingGen >= currentGen;
}

/** 旧代次的“控制者退场(null)”消息不能清除新代次控制者。 */
export function shouldClearController(
  currentGen: number | null,
  nullGen: number,
): boolean {
  if (currentGen === null) return false;
  return nullGen >= currentGen;
}
