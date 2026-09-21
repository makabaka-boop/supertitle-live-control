import { useCallback, useEffect, useRef, useState } from 'react';
import type { Cue, FrozenProgram, ProgramDraft } from '../types';
import {
  adoptProgram,
  EmptyProgramError,
  loadPersisted,
  newEmptyDraft,
  saveDraft,
} from './db';

export interface ProgramState {
  draft: ProgramDraft;
  frozen: FrozenProgram | null;
  saving: boolean;
  savedAt: number | null;
  error: string | null;
}

function newCueId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `cue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeCue(kind: Cue['kind']): Cue {
  return {
    id: newCueId(),
    kind,
    source: '',
    translation: '',
    note: '',
  };
}

/**
 * 节目单草稿的编辑 / 排序 / 持久化。
 * 草稿与冻结在演版本分离：adopt 写入的是当前 cues 的快照，
 * 之后再改草稿不影响 frozen，直到再次采用。
 */
export function useProgram() {
  const [state, setState] = useState<ProgramState>({
    draft: newEmptyDraft(),
    frozen: null,
    saving: false,
    savedAt: null,
    error: null,
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadPersisted()
      .then(({ draft, frozen }) => {
        if (cancelled) return;
        loaded.current = true;
        setState((s) => ({ ...s, draft, frozen }));
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState((s) => ({
            ...s,
            error: `读取节目单失败：${err instanceof Error ? err.message : String(err)}`,
          }));
        }
      });
    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const persistDraft = useCallback((next: ProgramDraft) => {
    setState((s) => ({ ...s, saving: true, error: null }));
    void saveDraft(next)
      .then(() => {
        setState((s) =>
          s.draft === next
            ? { ...s, saving: false, savedAt: Date.now() }
            : s,
        );
      })
      .catch((err: unknown) => {
        setState((s) => ({
          ...s,
          saving: false,
          error: `草稿保存失败：${err instanceof Error ? err.message : String(err)}`,
        }));
      });
  }, []);

  /** 本地修改 + 防抖落盘；始终只改草稿，不碰冻结版本。 */
  const mutate = useCallback(
    (fn: (cues: Cue[]) => Cue[]) => {
      setState((s) => {
        const cues = fn(s.draft.cues);
        const draft: ProgramDraft = {
          cues,
          draftRev: s.draft.draftRev + 1,
          updatedAt: Date.now(),
        };
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => persistDraft(draft), 400);
        return { ...s, draft, saving: true };
      });
    },
    [persistDraft],
  );

  const addCue = useCallback(
    (kind: Cue['kind']) => mutate((cues) => [...cues, makeCue(kind)]),
    [mutate],
  );

  const updateCue = useCallback(
    (id: string, patch: Partial<Omit<Cue, 'id'>>) =>
      mutate((cues) =>
        cues.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      ),
    [mutate],
  );

  const removeCue = useCallback(
    (id: string) => mutate((cues) => cues.filter((c) => c.id !== id)),
    [mutate],
  );

  const moveCue = useCallback(
    (id: string, dir: -1 | 1) =>
      mutate((cues) => {
        const idx = cues.findIndex((c) => c.id === id);
        const target = idx + dir;
        if (idx < 0 || target < 0 || target >= cues.length) return cues;
        const copy = cues.slice();
        const [item] = copy.splice(idx, 1);
        copy.splice(target, 0, item);
        return copy;
      }),
    [mutate],
  );

  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const draft = state.draft;
    try {
      await saveDraft(draft);
      setState((s) => ({ ...s, saving: false, savedAt: Date.now() }));
    } catch (err) {
      setState((s) => ({
        ...s,
        saving: false,
        error: `草稿保存失败：${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  }, [state.draft]);

  /** 采用节目单：空单拒绝；成功后冻结快照。 */
  const adopt = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const cues = state.draft.cues;
    try {
      const frozen = await adoptProgram(cues);
      setState((s) => ({ ...s, frozen, error: null, savedAt: Date.now() }));
      return true;
    } catch (err) {
      if (err instanceof EmptyProgramError) {
        setState((s) => ({ ...s, error: '空节目单不能采用，请先添加字幕或黑场提示。' }));
      } else {
        setState((s) => ({
          ...s,
          error: `采用失败：${err instanceof Error ? err.message : String(err)}`,
        }));
      }
      return false;
    }
  }, [state.draft.cues]);

  return {
    state,
    loaded,
    addCue,
    updateCue,
    removeCue,
    moveCue,
    adopt,
    flushSave,
  };
}
