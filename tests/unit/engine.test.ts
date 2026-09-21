import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { StageEngine, isNewerFrame } from '../../src/lib/engine';
import { getFrame } from '../../src/lib/db';
import { makeCue } from '../../src/lib/program';
import type { Cue, ControllerInfo, Frame } from '../../src/types';
import { FakeChannelNetwork, FakeChannel, FakeLockManager } from './fakes';

function cue(zh: string, it: string): Cue {
  const c = makeCue('subtitle');
  c.zh = zh;
  c.it = it;
  return c;
}

const C1 = cue('第一句', 'Prima');
const C2 = cue('第二句', 'Seconda');

function waitFor(
  predicate: () => boolean,
  { timeout = 1000, interval = 10 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitFor 超时'));
      setTimeout(tick, interval);
    };
    tick();
  });
}

describe('StageEngine 多页争用仲裁', () => {
  let idb: IDBFactory;
  let locks: FakeLockManager;
  let network: FakeChannelNetwork;
  let times: { value: number };

  beforeEach(() => {
    idb = new IDBFactory();
    locks = new FakeLockManager();
    network = new FakeChannelNetwork();
    times = { value: 1000 };
  });

  function makeEngine() {
    return new StageEngine({
      locks,
      channel: new FakeChannel(network),
      idbFactory: idb,
      now: () => times.value,
    });
  }

  const ALICE: ControllerInfo = { id: 'ctl-A', name: '甲' };
  const BOB: ControllerInfo = { id: 'ctl-B', name: '乙' };

  it('同时开演：持锁者成为唯一控制者，另一页排队等待（只读显示画面与控制者）', async () => {
    const a = makeEngine();
    const b = makeEngine();

    void a.start(ALICE, 'prog-1');
    await waitFor(() => a.getState().role === 'leader');
    void b.start(BOB, 'prog-1');
    await waitFor(() => b.getState().role === 'waiting');

    expect(a.getState().frame?.generation).toBe(1);
    expect(b.getState().frame?.generation).toBe(1);
    expect(b.getState().frame?.controllerName).toBe('甲');
  });

  it('控制者切句：同事务校验、seq 递增，从页与持久层最终一致', async () => {
    const a = makeEngine();
    const b = makeEngine();
    void a.start(ALICE, 'prog-1');
    await waitFor(() => a.getState().role === 'leader');
    void b.start(BOB, 'prog-1');
    await waitFor(() => b.getState().role === 'waiting');

    await a.showCue(C1, 0);
    await waitFor(() => b.getState().frame?.seq === 1);
    await a.showCue(C2, 1);
    await waitFor(() => b.getState().frame?.zh === '第二句');

    expect(a.getState().frame?.seq).toBe(2);
    expect(b.getState().frame).toEqual(a.getState().frame);

    // 模拟“投影页重开”：纯读持久状态
    const projector = makeEngine();
    await projector.init();
    expect(projector.getState().frame?.seq).toBe(2);
    expect(projector.getState().frame?.zh).toBe('第二句');
  });

  it('控制页关闭后等待者接管：新代次发布后，观众最终只见新代次画面', async () => {
    const a = makeEngine();
    const b = makeEngine();
    const projector = makeEngine();

    void a.start(ALICE, 'prog-1');
    await waitFor(() => a.getState().role === 'leader');
    void b.start(BOB, 'prog-1');
    await waitFor(() => b.getState().role === 'waiting');
    await projector.init();

    await a.showCue(C1, 0);
    await waitFor(() => projector.getState().frame?.zh === '第一句');

    // 甲的控制页关闭（destroy 释放锁）
    a.destroy();
    await waitFor(() => b.getState().role === 'leader');
    expect(b.getState().frame?.generation).toBe(2);
    await waitFor(() => projector.getState().frame?.generation === 2);

    await b.showCue(C2, 1);
    await waitFor(() => projector.getState().frame?.zh === '第二句');
    expect(projector.getState().frame?.controllerId).toBe('ctl-B');

    // 旧控制者对象虽已销毁，若它持有过期帧也无法影响任何仲裁：
    // 投影当前帧已是 g2，旧 g1 帧按规则被拒绝（下面直接验证 isNewerFrame）。
    const staleG1: Frame = {
      ...(projector.getState().frame as Frame),
      generation: 1,
      seq: 99,
    };
    expect(isNewerFrame(staleG1, projector.getState().frame)).toBe(false);
  });

  it('失锁旧页立即禁用：其后续操作全部被拒，不会覆盖新代次', async () => {
    const a = makeEngine();
    const b = makeEngine();
    const projector = makeEngine();

    void a.start(ALICE, 'prog-1');
    await waitFor(() => a.getState().role === 'leader');
    void b.start(BOB, 'prog-1');
    await waitFor(() => b.getState().role === 'waiting');
    await projector.init();

    await a.showCue(C1, 0);

    // 外部抢占（模拟浏览器让锁失效）：甲立即 lost，乙随后获锁
    locks.steal();
    await waitFor(() => a.getState().role === 'lost');
    await waitFor(() => b.getState().role === 'leader');
    await waitFor(() => projector.getState().frame?.generation === 2);

    // 旧页再切句：直接被拒，不发起有效写入（busy 不会重新挂起、seq 不增加）
    const seqBefore = projector.getState().frame?.seq;
    await a.showCue(C2, 1);
    expect(a.getState().role).toBe('lost');
    expect(a.getState().error).toContain('控制权已丢失');

    await new Promise((r) => setTimeout(r, 30));
    const persisted = await getFrame(idb);
    expect(persisted?.generation).toBe(2);
    expect(persisted?.controllerId).toBe('ctl-B');
    expect(persisted?.seq).toBe(seqBefore); // 旧页没有制造任何新帧
    expect(projector.getState().frame?.generation).toBe(2);
  });

  it('迟到消息不得覆盖新代次：同代次更小 seq 也被拒', async () => {
    const projector = makeEngine();
    const g2s5: Frame = {
      generation: 2,
      seq: 5,
      kind: 'subtitle',
      cueId: 'c2',
      cueIndex: 1,
      zh: '新代次画面',
      it: 'nuova',
      programId: 'p',
      controllerId: 'ctl-B',
      controllerName: '乙',
      publishedAt: 2,
    };
    const g2s4: Frame = { ...g2s5, seq: 4, zh: '同代次旧序号' };
    const g1s99: Frame = { ...g2s5, generation: 1, seq: 99, zh: '旧代次迟到消息' };

    // 用广播投递而非直接赋值
    const sender = new FakeChannel(network);
    void projector;
    sender.post({ type: 'frame', frame: g2s5 });
    await waitFor(() => projector.getState().frame?.seq === 5);
    sender.post({ type: 'frame', frame: g2s4 });
    sender.post({ type: 'frame', frame: g1s99 });
    await new Promise((r) => setTimeout(r, 30));

    expect(projector.getState().frame?.zh).toBe('新代次画面');
  });

  it('黑场发布：观众画面切为黑场帧且 seq 递增', async () => {
    const a = makeEngine();
    const projector = makeEngine();
    void a.start(ALICE, 'prog-1');
    await waitFor(() => a.getState().role === 'leader');
    await projector.init();

    await a.showCue(C1, 0);
    await waitFor(() => projector.getState().frame?.kind === 'subtitle');
    await a.blackout();
    await waitFor(() => projector.getState().frame?.kind === 'blackout');
    expect(projector.getState().frame?.seq).toBe(2);
  });

  it('写入失败：保持上一幅确认画面并报错，绝不先报成功', async () => {
    // 先正常成为 leader 并发布一帧
    const a = makeEngine();
    void a.start(ALICE, 'prog-1');
    await waitFor(() => a.getState().role === 'leader');
    await a.showCue(C1, 0);
    const confirmed = a.getState().frame;
    expect(confirmed?.zh).toBe('第一句');

    // 包装真实库：readwrite 事务一律抛错（模拟磁盘/配额失败）
    const failingFactory: IDBFactory = {
      open: ((...args: [string, number?]) => {
        const req = idb.open(...args);
        req.addEventListener('success', () => {
          const realDb = req.result;
          const proxy: IDBDatabase = new Proxy(realDb, {
            get(target, prop, receiver) {
              if (prop === 'transaction') {
                return (_store: string, mode?: IDBTransactionMode) => {
                  if (mode === 'readwrite') {
                    throw new Error('模拟磁盘写入失败');
                  }
                  return Reflect.get(target, prop, receiver).call(
                    target,
                    _store,
                    mode,
                  );
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          Object.defineProperty(req, 'result', { value: proxy, configurable: true });
        });
        return req;
      }) as IDBFactory['open'],
    } as unknown as IDBFactory;

    const failingEngine = new StageEngine({
      locks,
      channel: new FakeChannel(network),
      idbFactory: failingFactory,
      now: () => times.value,
    });
    // 直接复用当前已确认帧构造“发布时失败”场景：
    // 手动把引擎内部状态带到 leader，再让其走真实 publish 路径。
    failingEngine['state'] = {
      role: 'leader',
      frame: confirmed,
      busy: false,
      error: null,
      programId: 'prog-1',
      controller: ALICE,
    };
    await failingEngine.showCue(C2, 1);

    const s = failingEngine.getState();
    expect(s.busy).toBe(false);
    expect(s.error).toContain('写入失败');
    // 画面仍是上一幅已确认帧
    expect(s.frame?.zh).toBe('第一句');
    expect(s.role).toBe('leader');

    // 真正的持久帧也未改变
    const persisted = await getFrame(idb);
    expect(persisted?.zh).toBe('第一句');
  });
});
