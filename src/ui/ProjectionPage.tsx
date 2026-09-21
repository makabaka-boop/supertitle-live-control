import { useEffect, useState } from 'react';
import type { Frame } from '../types';
import { getFrame } from '../lib/db';
import { isNewerFrame } from '../lib/engine';
import { detectCapabilities } from '../lib/capabilities';

const CHANNEL_NAME = 'opera-stage';

/**
 * 投影页：纯只读。
 * - 打开/重开时先读 IndexedDB 里的持久画面；
 * - 之后只接受“更高代次或同代次更大序号”的广播帧；
 * - 永不争抢控制锁，永不写库。
 */
export function ProjectionPage() {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const caps = detectCapabilities();

  useEffect(() => {
    let cancelled = false;
    let channel: BroadcastChannel | null = null;

    getFrame()
      .then((f) => {
        if (!cancelled) {
          setFrame(f ?? null);
          setLoaded(true);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(`读取持久画面失败：${err instanceof Error ? err.message : String(err)}`);
          setLoaded(true);
        }
      });

    if (caps.broadcastChannel) {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (ev: MessageEvent<{ type: string; frame?: Frame }>) => {
        const incoming = ev.data?.frame;
        if (!incoming) return;
        setFrame((current) => (isNewerFrame(incoming, current) ? incoming : current));
      };
    }

    return () => {
      cancelled = true;
      channel?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const black = !frame || frame.kind === 'blackout';

  return (
    <div className={`projection ${black ? 'is-blackout' : 'is-subtitle'}`}>
      {!loaded && <div className="proj-status">正在载入持久画面…</div>}
      {loaded && error && <div className="proj-status error">{error}</div>}
      {loaded && !error && black && <div className="proj-blackout" data-testid="proj-blackout" />}
      {loaded && !error && frame?.kind === 'subtitle' && (
        <div className="proj-subtitles" data-testid="proj-subtitles" data-generation={frame.generation} data-seq={frame.seq}>
          <div className="proj-zh">{frame.zh}</div>
          <div className="proj-it">{frame.it}</div>
        </div>
      )}
      <div className="proj-corner" data-testid="proj-corner">
        {frame
          ? `g${frame.generation} #${frame.seq} · 控制者 ${frame.controllerName}`
          : '尚无在演画面（黑场）'}
        {!caps.broadcastChannel && ' · 实时通道不可用：刷新以读取持久画面'}
      </div>
    </div>
  );
}
