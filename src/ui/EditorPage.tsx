import { useEffect, useMemo, useState } from 'react';
import type { Cue, StoredProgram } from '../types';
import { getProgram, saveProgram } from '../lib/db';
import { adoptProgram, makeCue, normalizeText, validateCues } from '../lib/program';

export function EditorPage() {
  const [cues, setCues] = useState<Cue[]>([]);
  const [stored, setStored] = useState<StoredProgram | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProgram()
      .then((p) => {
        if (cancelled) return;
        if (p) {
          setStored(p);
          // 以在演版本为草稿起点；修改草稿不会回写已冻结版本。
          setCues(p.cues.map((c) => ({ ...c })));
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(`读取已采用节目单失败：${errMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const errors = useMemo(() => validateCues(cues), [cues]);

  function updateCue(id: string, patch: Partial<Cue>) {
    setCues((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function move(index: number, delta: -1 | 1) {
    setCues((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function remove(id: string) {
    setCues((prev) => prev.filter((c) => c.id !== id));
  }

  async function handleAdopt() {
    setAdoptError(null);
    const cleaned = cues.map((c) => ({
      ...c,
      zh: normalizeText(c.zh),
      it: normalizeText(c.it),
    }));
    const problems = validateCues(cleaned);
    if (problems.length > 0) {
      setAdoptError(problems.join(' '));
      return;
    }
    const program = adoptProgram(cleaned, Date.now());
    try {
      await saveProgram(program);
      // 只有事务成功后才更新界面（持久化失败不会出现“先成功后回退”）。
      setStored(program);
      setCues(program.cues.map((c) => ({ ...c })));
      setSavedAt(program.adoptedAt);
    } catch (err) {
      setAdoptError(`采用失败（节目单未冻结）：${errMessage(err)}`);
    }
  }

  return (
    <div className="page editor-page">
      <section className="panel">
        <h2>节目单编辑</h2>
        <p className="hint">
          编辑、排序并预览双语字幕与黑场提示。只有点击「采用节目单」才会冻结在演版本；
          此后继续修改不会影响已冻结版本，需再次采用。空节目单不能采用。
        </p>
        {loadError && <div className="error-banner">{loadError}</div>}

        <div className="cue-toolbar">
          <button type="button" onClick={() => setCues((p) => [...p, makeCue('subtitle')])}>
            ＋ 双语字幕
          </button>
          <button type="button" onClick={() => setCues((p) => [...p, makeCue('blackout')])}>
            ＋ 黑场提示
          </button>
          <span className="cue-count">共 {cues.length} 条</span>
        </div>

        <ol className="cue-list">
          {cues.map((cue, i) => (
            <li key={cue.id} className={`cue-row cue-${cue.kind}`}>
              <div className="cue-head">
                <span className="cue-index">#{i + 1}</span>
                <span className="cue-kind">{cue.kind === 'subtitle' ? '双语字幕' : '黑场提示'}</span>
                <span className="cue-spacer" />
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)}>
                  上移
                </button>
                <button type="button" disabled={i === cues.length - 1} onClick={() => move(i, 1)}>
                  下移
                </button>
                <button type="button" className="danger" onClick={() => remove(cue.id)}>
                  删除
                </button>
              </div>
              {cue.kind === 'subtitle' ? (
                <div className="cue-fields">
                  <label>
                    中文
                    <textarea
                      rows={2}
                      value={cue.zh}
                      onChange={(e) => updateCue(cue.id, { zh: e.target.value })}
                      placeholder="中文唱词/字幕"
                    />
                  </label>
                  <label>
                    原文
                    <textarea
                      rows={2}
                      value={cue.it}
                      onChange={(e) => updateCue(cue.id, { it: e.target.value })}
                      placeholder="Testo originale"
                    />
                  </label>
                </div>
              ) : (
                <div className="cue-fields single">
                  <span className="blackout-note">黑场：投影不显示任何唱词（可在开演页手动切换）。</span>
                </div>
              )}
            </li>
          ))}
          {cues.length === 0 && <li className="empty-row">还没有任何条目，请先添加双语字幕或黑场提示。</li>}
        </ol>

        <div className="adopt-bar">
          <button
            type="button"
            className="primary"
            disabled={errors.length > 0}
            onClick={handleAdopt}
            title={errors.length > 0 ? errors.join(' ') : '冻结为在演版本'}
          >
            采用节目单（冻结在演版本）
          </button>
          {errors.length > 0 && (
            <ul className="validation-errors">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {adoptError && <div className="error-banner">{adoptError}</div>}
        </div>
      </section>

      <section className="panel preview-panel" data-testid="preview-panel">
        <h2>预览</h2>
        <ol className="preview-list">
          {cues.map((cue, i) => (
            <li key={cue.id} className={`preview-item preview-${cue.kind}`}>
              <span className="cue-index">#{i + 1}</span>
              {cue.kind === 'subtitle' ? (
                <div>
                  <div className="preview-zh">{cue.zh || <em>（中文为空）</em>}</div>
                  <div className="preview-it">{cue.it || <em>（原文为空）</em>}</div>
                </div>
              ) : (
                <div className="preview-blackout">● 黑场</div>
              )}
            </li>
          ))}
          {cues.length === 0 && <li className="empty-row">预览为空。</li>}
        </ol>
        <div className="frozen-info" data-testid="frozen-info">
          {stored ? (
            <>
              <strong>当前在演版本：</strong>
              已于 {formatTime(stored.adoptedAt)} 冻结，含 {stored.cues.length} 条（版本 {stored.id}）。
            </>
          ) : (
            '尚未采用任何节目单，开演页无法开演。'
          )}
          {savedAt && <div className="ok-line">✔ 已持久化，刷新页面不会回退。</div>}
        </div>
      </section>
    </div>
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
