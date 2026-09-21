import { useEffect, useMemo, useState } from 'react';
import type { CapabilityReport, Cue, FrameContent, FrameState } from '../types';
import {
  ControllerSession,
  createIdentity,
} from '../lib/sessions';
import { useSession } from '../lib/useSessionSnapshot';
import { loadPersisted } from '../lib/db';
import { StageView } from '../components/StageView';

interface ControlPageProps {
  capabilities: CapabilityReport;
}

export function ControlPage({ capabilities }: ControlPageProps) {
  // 整个页面生命周期只创建一个控制会话（身份、锁、通道绑定）。
  const session = useMemo(
    () => new ControllerSession(createIdentity('主控台')),
    [],
  );
  const snapshot = useSession(session);

  const [frozenCues, setFrozenCues] = useState<Cue[] | null>(null);
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // 打开即读取冻结版本；能力齐全才进入唯一锁竞争，缺项时只做静态展示。
  const banned = capabilities.missing.length > 0;

  useEffect(() => {
    let disposed = false;
    void loadPersisted().then(({ frozen }) => {
      if (disposed) return;
      setFrozenCues(frozen?.cues ?? null);
      setFrozenAt(frozen?.frozenAt ?? null);
    });
    if (banned) {
      setLoadError('缺少演出所需能力，已禁止开演。');
      return () => {
        disposed = true;
      };
    }
    void session.hydrateFrame();
    void session.enterContention();

    const onUnload = () => void session.standDown();
    window.addEventListener('pagehide', onUnload);
    return () => {
      disposed = true;
      window.removeEventListener('pagehide', onUnload);
      void session.dispose();
    };
  }, [session, banned]);

  const isLeader = snapshot.status.role === 'leader';
  const isWaiting = snapshot.status.role === 'waiting';
  const isLost = snapshot.status.role === 'lost';
  const lostGeneration =
    snapshot.status.role === 'lost' ? snapshot.status.generation : 0;
  const waitingController =
    snapshot.status.role === 'waiting' ? snapshot.status.controller : null;
  const activeIndex = useMemo(() => {
    const id = snapshot.frame?.content.cueId;
    if (!id || !frozenCues) return -1;
    return frozenCues.findIndex((c) => c.id === id);
  }, [snapshot.frame, frozenCues]);

  async function send(content: FrameContent) {
    setActionError(null);
    try {
      await session.publish(content);
    } catch (err) {
      // 事务失败（含失锁、代次过期、控制者不符）：画面未变，报错。
      setActionError(
        err instanceof Error ? err.message : `操控失败：${String(err)}`,
      );
    }
  }

  function cueContent(cue: Cue): FrameContent {
    if (cue.kind === 'blackout') {
      return { kind: 'blackout', cueId: cue.id, source: '', translation: '' };
    }
    return {
      kind: 'subtitle',
      cueId: cue.id,
      source: cue.source,
      translation: cue.translation,
    };
  }

  function gotoCue(index: number) {
    if (!frozenCues || index < 0 || index >= frozenCues.length) return;
    void send(cueContent(frozenCues[index]));
  }

  function go(delta: -1 | 1) {
    if (!frozenCues) return;
    const base = activeIndex >= 0 ? activeIndex : -1;
    const next = base + delta;
    if (next < 0 || next >= frozenCues.length) return;
    gotoCue(next);
  }

  function explicitBlackout() {
    void send({ kind: 'blackout', cueId: null, source: '', translation: '' });
  }

  const shownError = actionError ?? snapshot.error ?? loadError;

  return (
    <div className="performance-layout">
      <div className="stage-area" data-testid="stage">
        <StageView frame={snapshot.frame} />
        {isLost && (
          <div className="lost-overlay" data-testid="lost-overlay">
            <h2>本页已失去控制权</h2>
            <p className="muted">
              另一个控制页面已接管（第 {lostGeneration} 代之后的新代次）。
              本页操控已全部禁用，迟到操作不会影响投影。
            </p>
            <button className="btn" onClick={() => location.reload()}>
              重新进入排队
            </button>
          </div>
        )}
      </div>

      <aside className="side-panel">
        {banned && (
          <div className="capability-warning" data-testid="cap-warning">
            <h3>缺少演出能力，禁止开演</h3>
            <ul>
              {capabilities.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <p className="muted">节目单仍可在“编辑”页修改。</p>
          </div>
        )}

        <StatusLine
          status={snapshot.status}
          frame={snapshot.frame}
          banned={banned}
        />

        {shownError && (
          <div className="error-banner" role="alert" data-testid="control-error">
            {shownError}
          </div>
        )}

        {banned ? (
          <div className="muted">
            能力缺失，本页不会参与开演，也不提供任何操控入口。
            请更换支持 IndexedDB / Web Locks / BroadcastChannel 的浏览器后重试。
          </div>
        ) : frozenCues === null ? (
          <div className="muted">读取在演版本…</div>
        ) : frozenCues.length === 0 ? (
          <div className="error-banner" data-testid="no-program">
            尚未采用节目单。请先到“编辑”页排好节目单并点击“采用节目单”。
          </div>
        ) : (
          <>
            <div className="nav-row">
              <button
                className="btn"
                data-testid="prev-cue"
                disabled={!isLeader || activeIndex <= 0}
                onClick={() => go(-1)}
              >
                ↑ 上一句
              </button>
              <button
                className="btn"
                data-testid="next-cue"
                disabled={!isLeader || activeIndex === frozenCues.length - 1}
                onClick={() => go(1)}
              >
                下一句 ↓
              </button>
            </div>
            <button
              className="btn danger big-stage-button"
              data-testid="blackout-btn"
              disabled={!isLeader}
              onClick={explicitBlackout}
            >
              ● 黑场（不投文字）
            </button>

            <div className="cue-run-list" data-testid="cue-run-list">
              {frozenCues.map((cue, i) => (
                <button
                  key={cue.id}
                  className={`cue-run${i === activeIndex ? ' active' : ''}`}
                  disabled={!isLeader}
                  data-testid="cue-run"
                  data-active={i === activeIndex}
                  onClick={() => gotoCue(i)}
                >
                  <div className="cue-run-kind">
                    {i + 1}. {cue.kind === 'blackout' ? '黑场' : '字幕'}
                  </div>
                  {cue.kind === 'subtitle' ? (
                    <>
                      <div className="cue-run-src">{cue.source || '（原文空）'}</div>
                      <div className="cue-run-tr">{cue.translation || '（译文空）'}</div>
                    </>
                  ) : (
                    <div className="cue-run-src muted">{cue.note || '全黑'}</div>
                  )}
                </button>
              ))}
            </div>
            <div className="muted">
              在演版本冻结于{' '}
              {frozenAt ? new Date(frozenAt).toLocaleString() : '—'}，
              共 {frozenCues.length} 条；之后的编辑不影响本版本。
            </div>
          </>
        )}

        {isLeader && (
          <button
            className="btn"
            data-testid="stand-down"
            onClick={() => void session.standDown()}
          >
            退场交权（交给排队页面）
          </button>
        )}
        {isWaiting && (
          <div className="status-line waiting" data-testid="waiting-banner">
            正在等待唯一操控权：当前已有控制页持锁。
            {waitingController
              ? ` 控制者：${waitingController.label}（第 ${waitingController.generation} 代）`
              : ''}
            {' '}对方关闭或退场后本页自动接管。
          </div>
        )}
      </aside>
    </div>
  );
}

function StatusLine({
  status,
  frame,
  banned,
}: {
  status: ReturnType<typeof useSession>['status'];
  frame: FrameState | null;
  banned: boolean;
}) {
  if (banned) {
    return (
      <div className="status-line lost" data-testid="status-line">
        能力缺失：本页不会参与开演。
      </div>
    );
  }
  if (status.role === 'leader') {
    return (
      <div className="status-line leader" data-testid="status-line">
        ● 本页是唯一操控者 · 第 {status.generation} 代
        <div className="controller-readout">
          {frame
            ? `画面序号 ${frame.sequence} · 控制者 ${status.controllerId.slice(0, 8)}`
            : ''}
        </div>
      </div>
    );
  }
  if (status.role === 'waiting') {
    return (
      <div className="status-line waiting" data-testid="status-line">
        ◌ 排队等待控制权（只读监视中）
      </div>
    );
  }
  if (status.role === 'lost') {
    return (
      <div className="status-line lost" data-testid="status-line">
        ✕ 已失锁（第 {status.generation} 代）· 操控禁用
      </div>
    );
  }
  return (
    <div className="status-line" data-testid="status-line">
      只读监视中
    </div>
  );
}
