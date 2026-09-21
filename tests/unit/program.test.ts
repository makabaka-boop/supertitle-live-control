import { describe, expect, it } from 'vitest';
import { adoptProgram, makeCue, validateCues } from '../../src/lib/program';

describe('validateCues（采用节目单校验）', () => {
  it('空节目单不能采用', () => {
    const errors = validateCues([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('为空');
  });

  it('双语字幕必须同时有中文与原文', () => {
    const onlyZh = makeCue('subtitle');
    onlyZh.zh = '夜深沉';
    expect(validateCues([onlyZh]).some((e) => e.includes('原文'))).toBe(true);

    const onlyIt = makeCue('subtitle');
    onlyIt.it = 'O notte';
    expect(validateCues([onlyIt]).some((e) => e.includes('中文'))).toBe(true);

    const both = makeCue('subtitle');
    both.zh = '夜深沉';
    both.it = 'O notte';
    expect(validateCues([both])).toEqual([]);
  });

  it('黑场提示无需文本，可单独成单', () => {
    expect(validateCues([makeCue('blackout')])).toEqual([]);
  });

  it('adoptProgram 冻结深拷贝：之后的编辑不影响已采用版本', () => {
    const cue = makeCue('subtitle');
    cue.zh = '旧中文';
    cue.it = 'Vecchio';
    const frozen = adoptProgram([cue], 1000);

    cue.zh = '改后的草稿中文';
    frozen.cues[0]!.zh = '不应被外部共享引用'; // 直接改的是快照副本
    expect(frozen.cues[0]).not.toBe(cue);

    const frozen2 = adoptProgram(
      [
        (() => {
          const c = makeCue('subtitle');
          c.zh = '夜深沉';
          c.it = 'O notte';
          return c;
        })(),
      ],
      2000,
    );
    expect(frozen2.cues[0]!.zh).toBe('夜深沉');
    expect(frozen2.adoptedAt).toBe(2000);
    expect(frozen2.id).toMatch(/^program_/);
  });
});
