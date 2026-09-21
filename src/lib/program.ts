import type { Cue, CueKind, StoredProgram } from '../types';

/** 去掉两端空白的受控文本 */
export function normalizeText(s: string): string {
  return s.trim();
}

export function validateCues(cues: Cue[]): string[] {
  const errors: string[] = [];
  if (cues.length === 0) {
    errors.push('节目单为空：至少需要一条字幕或黑场提示才能采用。');
    return errors;
  }
  cues.forEach((cue, i) => {
    const n = i + 1;
    if (cue.kind === 'subtitle') {
      if (!cue.zh.trim() && !cue.it.trim()) {
        errors.push(`第 ${n} 条字幕中文与原文均为空。`);
      } else if (!cue.zh.trim()) {
        errors.push(`第 ${n} 条字幕缺少中文。`);
      } else if (!cue.it.trim()) {
        errors.push(`第 ${n} 条字幕缺少原文。`);
      }
    }
    if (cue.kind !== 'subtitle' && cue.kind !== 'blackout') {
      errors.push(`第 ${n} 条类型非法。`);
    }
  });
  return errors;
}

/** 冻结在演版本：深拷贝，排序结果固化，后续编辑不影响它 */
export function adoptProgram(cues: Cue[], now: number): StoredProgram {
  return {
    id: createId('program'),
    adoptedAt: now,
    cues: cues.map((c) => ({ ...c })),
  };
}

export function makeCue(kind: CueKind): Cue {
  return { id: createId('cue'), kind, zh: '', it: '' };
}

export function createId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
