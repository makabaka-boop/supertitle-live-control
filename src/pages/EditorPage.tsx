import { useMemo } from 'react';
import type { CapabilityReport, Cue } from '../types';
import { useProgram } from '../lib/useProgram';

interface EditorPageProps {
  capabilities: CapabilityReport;
}

export function EditorPage({ capabilities }: EditorPageProps) {
  const { state, addCue, updateCue, removeCue, moveCue, adopt } = useProgram();
  const { draft, frozen, saving, savedAt, error } = state;

  // 预览按当前编辑顺序生成（黑场条目也占一位）。
  const previewCues = useMemo(
    () => draft.cues.slice(0, 6),
    [draft.cues],
  );

  return (
    <div className="content">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {capabilities.missing.length > 0 && (
        <div className="capability-warning" data-testid="cap-warning">
          <h3>当前浏览器缺少演出所需能力（仍可编辑节目单，但禁止开演）</h3>
          <ul>
            {capabilities.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {frozen && (
        <div className="frozen-banner" data-testid="frozen-banner">
          ✦ 已采用在演版本：{frozen.cues.length} 条，
          冻结于 {new Date(frozen.frozenAt).toLocaleString()}。
          继续编辑不会影响正在演出的版本，需再次点“采用节目单”才会更新。
        </div>
      )}

      <div className="editor-toolbar">
        <button className="btn" onClick={() => addCue('subtitle')}>
          ＋ 双语字幕
        </button>
        <button className="btn" onClick={() => addCue('blackout')}>
          ＋ 黑场提示
        </button>
        <button
          className="btn primary"
          data-testid="adopt-button"
          disabled={draft.cues.length === 0 || saving}
          onClick={() => void adopt()}
          title={
            draft.cues.length === 0
              ? '空节目单不能采用'
              : '把当前编辑内容冻结为在演版本'
          }
        >
          采用节目单
        </button>
        <span className="save-state">
          {saving ? '保存中…' : savedAt ? `草稿已保存 ${new Date(savedAt).toLocaleTimeString()}` : ''}
        </span>
      </div>

      {draft.cues.length === 0 ? (
        <div className="empty-hint">
          节目单为空。添加第一条双语字幕或黑场提示；空节目单无法采用。
        </div>
      ) : (
        draft.cues.map((cue, idx) => (
          <CueEditor
            key={cue.id}
            cue={cue}
            index={idx}
            total={draft.cues.length}
            onUpdate={(patch) => updateCue(cue.id, patch)}
            onRemove={() => removeCue(cue.id)}
            onMove={(dir) => moveCue(cue.id, dir)}
          />
        ))
      )}

      <div className="preview-panel">
        <h3>投影预览（按当前排序）</h3>
        <div className="stage-preview">
          {previewCues.length === 0 ? (
            <span className="muted">尚无可预览条目</span>
          ) : (
            previewCues.map((c, i) =>
              c.kind === 'blackout' ? (
                <div className="blackout" key={c.id}>
                  ◼ 黑场 {i + 1}
                  {c.note ? `｜${c.note}` : ''}
                </div>
              ) : (
                <div key={c.id}>
                  <div className="src">{c.source || '（原文空）'}</div>
                  <div className="tr">{c.translation || '（译文空）'}</div>
                </div>
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}

interface CueEditorProps {
  cue: Cue;
  index: number;
  total: number;
  onUpdate: (patch: Partial<Omit<Cue, 'id'>>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

function CueEditor({ cue, index, total, onUpdate, onRemove, onMove }: CueEditorProps) {
  return (
    <div
      className={`cue-card${cue.kind === 'blackout' ? ' blackout' : ''}`}
      data-testid="cue-card"
      data-cue-id={cue.id}
    >
      <div className="cue-index">{index + 1}</div>
      <div className="cue-fields">
        <div className="row2">
          <select
            value={cue.kind}
            onChange={(e) => onUpdate({ kind: e.target.value as Cue['kind'] })}
            aria-label="条目类型"
          >
            <option value="subtitle">双语字幕</option>
            <option value="blackout">黑场提示</option>
          </select>
          <input
            value={cue.note}
            placeholder="舞台备注（仅控制端可见）"
            onChange={(e) => onUpdate({ note: e.target.value })}
          />
        </div>
        {cue.kind === 'subtitle' ? (
          <>
            <textarea
              value={cue.source}
              placeholder="原文行"
              data-field="source"
              onChange={(e) => onUpdate({ source: e.target.value })}
            />
            <textarea
              value={cue.translation}
              placeholder="译文行"
              data-field="translation"
              onChange={(e) => onUpdate({ translation: e.target.value })}
            />
          </>
        ) : (
          <div>
            <span className="kind-badge blackout">黑场：投影将全黑</span>
            <span className="muted" style={{ marginLeft: 8 }}>
              可用备注记录黑场意图，不投出文字。
            </span>
          </div>
        )}
      </div>
      <div className="cue-actions">
        <button
          className="icon-btn"
          aria-label="上移"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          className="icon-btn"
          aria-label="下移"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button
          className="icon-btn"
          aria-label="删除"
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
