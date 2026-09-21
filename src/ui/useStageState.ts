import { useSyncExternalStore } from 'react';
import type { StageEngine, StageState } from '../lib/engine';

/** 把 StageEngine 的订阅桥接到 React；engine 为 null 时返回 null（尚未就绪） */
export function useStageState(engine: StageEngine | null): StageState | null {
  return useSyncExternalStore(
    (onChange) => (engine ? engine.subscribe(onChange) : () => {}),
    () => (engine ? engine.getState() : null),
    () => (engine ? engine.getState() : null),
  );
}
