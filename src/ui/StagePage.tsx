import { useEffect, useMemo, useState } from 'react';
import type { StoredProgram } from '../types';
import { getProgram } from '../lib/db';
import { StageEngine, type StageState } from '../lib/engine';
import { BrowserLockManager, BrowserStageChannel } from '../lib/ports';
import { detectCapabilities, missingCapabilities } from '../lib/capabilities';
import { createId } from '../lib/program';
import { useStageState } from './useStageState';

const IDLE_STATE: StageState = {
  role: 'idle',
  frame: null,
  busy: false,
  error: null,
  programId: null,
  controller: null,
};

/**
 * 开演控制台。
 * 竞争唯一 Web Lock：等待 → 获锁后同事务取得递增代次并发布黑场起始帧。
 */
export function StagePage() {
  const [capabilities] = useState(() => detectCapabilities());
  const [engine, setEngine] = useState<StageEngine | null>(null);
  const [program, setProgram] = useState<StoredProgram | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(() => `控制台-${createId('c').slice(-4)}`);
  const state = useStageState(engine);

  useEffect(() => {
    let cancelled = false;
    getProgram()
      .then((p) => {
        if (!cancelled) setProgram(p ?? null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(`读取节目单失败：${errMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!capabilities.broadcastChannel) return;
    const eng = new StageEngine({
      locks: new BrowserLockManager(),
      channel: new BrowserStageChannel(),
    });
    setEngine(eng);
    void eng.init();
    // 测试钩子：模拟“旧控制页失锁”（等价于浏览器抢占/底层失效）。
    (window as unknown as Record<string, unknown>).__testStealLock = stealControlLock;
    return () => {
      eng.destroy();
      delete (window as unknown as Record<string, unknown>).__testStealLock;
    };
  }, [capabilities.broadcastChannel]);

  const missing = useMemo(() => missingCapabilities(capabilities), [capabilities]);
  const canStart =
    capabilities.locks &&
    capabilities.indexedDb &&
    capabilities.broadcastChannel &&
    !!program &&
    program.cues.length > 0;

  function start() {
    if (!engine || !program) return;
    void engine.start(
      { id: createId('ctl'), name: name.trim() || '未命名控制者' },
      program.id,
    );
  }

  return (
    <div className="page stage-page">
      <section className="panel">
        <h2>开演控制台</h2>
        {loadError && <div className="error-banner">{loadError}</div>}
        {missing.length > 0 && (
          <div className="error-banner" data-testid="missing-capabilities">
            当前浏览器缺少以下能力，仍可回到「节目单编辑」，但禁止开演：
            <ul>
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        {!program && missing.length === 0 && (
          <div className="warn-banner">
            还没有采用节目单。请先在编辑页整理并点击「采用节目单」。
          </div>
        )}
        {program && (
          <div className="program-meta">
            在演版本：{program.cues.length} 条 · 冻结于{' '}
            {new Date(program.adoptedAt).toLocaleString('zh-CN', { hour12: false })}
          </div>
        )}

        <StageControls
          engine={engine}
          state={state ?? IDLE_STATE}
          program={program}
          canStart={canStart}
          name={name}
          onName={setName}
          onStart={start}
        />
      </section>
    </div>
  );
}

function StageControls(props: {
  engine: StageEngine | null;
  state: StageState;
  program: StoredProgram | null;
  canStart: boolean;
  name: string;
  onName: (s: string) => void;
  onStart: () => void;
}) {
  const { engine, state, program, canStart, name, onName, onStart } = props;

  return (
    <>
      <div className="control-identity">
        <label>
          控制者名称
          <input
            value={name}
            onChange={(e) => onName(e.target.value)}
            disabled={state.role === 'leader' || state.role === 'waiting'}
          />
        </label>
      </div>

      <div className="role-banner" data-testid="role-banner" data-role={state.role}>
        {state.role === 'idle' && '尚未开演。'}
        {state.role === 'waiting' && (
          <>
            正在等待当前控制者释放锁（控制页关闭后自动接管）……
            {state.frame && (
              <span className="gen-tag">
                当前：{state.frame.controllerName} · g{state.frame.generation}
              </span>
            )}
          </>
        )}
        {state.role === 'leader' && (
          <>
            ● 本机为唯一有效控制者
            <span className="gen-tag">
              代次 g{state.frame?.generation} · 序号 {state.frame?.seq}
            </span>
          </>
        )}
        {state.role === 'follower' &&
          `只读中：当前控制者为「${state.frame?.controllerName ?? '—'}」（g${
            state.frame?.generation ?? '-'
          }）。锁释放后可接管。`}
        {state.role === 'lost' &&
          '本页控制权已失效，所有操作已禁用；请等待新控制者或重新接管。'}
      </div>

      {state.error && (
        <div className="error-banner" data-testid="stage-error">
          {state.error}
        </div>
      )}

      {(state.role === 'idle' ||
        state.role === 'follower' ||
        state.role === 'lost') && (
        <button
          type="button"
          className="primary"
          disabled={!canStart}
          onClick={onStart}
          data-testid="start-btn"
        >
          {state.role === 'follower'
            ? '排队等待接管'
            : state.role === 'lost'
              ? '重新排队接管（新代次）'
              : '开演'}
        </button>
      )}
      {state.role === 'waiting' && (
        <button type="button" className="primary" disabled>
          等待控制权中…
        </button>
      )}

      {state.role === 'leader' && program && (
        <div className="cue-console" data-testid="cue-console">
          <div className="cue-actions">
            <button
              type="button"
              className="primary"
              disabled={state.busy}
              onClick={() => void engine?.blackout()}
              data-testid="blackout-btn"
            >
              黑场
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => engine?.releaseControl()}
            >
              放弃控制（留在只读页）
            </button>
          </div>
          <ol className="cue-buttons">
            {program.cues.map((cue, i) => {
              const active = state.frame?.kind === 'subtitle' && state.frame.cueId === cue.id;
              if (cue.kind === 'blackout') {
                return (
                  <li key={cue.id}>
                    <button
                      type="button"
                      className={`cue-btn blackout ${active ? 'active' : ''}`}
                      disabled={state.busy}
                      onClick={() => void engine?.blackout()}
                      data-cue-index={i}
                    >
                      #{i + 1} 黑场
                    </button>
                  </li>
                );
              }
              return (
                <li key={cue.id}>
                  <button
                    type="button"
                    className={`cue-btn subtitle ${active ? 'active' : ''}`}
                    disabled={state.busy}
                    onClick={() => void engine?.showCue(cue, i)}
                    data-cue-index={i}
                  >
                    <span className="cue-btn-index">#{i + 1}</span>
                    <span className="cue-btn-zh">{cue.zh}</span>
                    <span className="cue-btn-it">{cue.it}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {state.frame && state.role !== 'leader' && (
        <div className="current-frame readonly-frame" data-testid="readonly-frame">
          <FrameReadonly frame={state.frame} />
        </div>
      )}
      {state.role === 'leader' && state.frame && (
        <div className="current-frame" data-testid="leader-frame">
          <FrameReadonly frame={state.frame} />
        </div>
      )}
    </>
  );
}

function FrameReadonly({ frame }: { frame: NonNullable<StageState['frame']> }) {
  if (frame.kind === 'blackout') {
    return (
      <div className="frame-blackout">
        ● 黑场（g{frame.generation} / #{frame.seq}）
      </div>
    );
  }
  return (
    <div>
      <div className="frame-zh">{frame.zh}</div>
      <div className="frame-it">{frame.it}</div>
      <div className="frame-meta">
        控制者：{frame.controllerName} · g{frame.generation} / #{frame.seq}
      </div>
    </div>
  );
}

/** 测试钩子：从页内抢占同名锁，触发旧持有者 abort（失锁） */
function stealControlLock(): Promise<void> {
  return new Promise<void>((resolve) => {
    void navigator.locks.request('opera-stage-control', { steal: true }, () => {
      return new Promise<void>((release) => {
        setTimeout(release, 200);
      });
    });
    setTimeout(resolve, 300);
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
