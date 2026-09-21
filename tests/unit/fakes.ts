import type { StageLock, StageMessage } from '../../src/lib/ports';

interface Holder {
  grant: (lock: StageLock) => void;
  controller: AbortController;
}

/**
 * 内存版 Web Locks：exclusive 互斥 + FIFO 队列。
 * 支持 steal()，用于模拟“旧控制页失锁”（对应 navigator.locks.request({steal:true})）。
 */
export class FakeLockManager {
  private current: Holder | null = null;
  private waiters: Holder[] = [];

  request(_name: string, callback: (lock: StageLock) => Promise<void>): Promise<void> {
    return new Promise<void>((outerResolve, outerReject) => {
      const controller = new AbortController();
      const holder: Holder = { grant: () => {}, controller };

      const run = async () => {
        try {
          await callback({ lost: controller.signal });
        } catch (err) {
          outerReject(err);
          return;
        } finally {
          if (this.current === holder) {
            this.current = null;
            const next = this.waiters.shift();
            if (next) this.activate(next);
          }
        }
        outerResolve();
      };

      holder.grant = (lock: StageLock) => {
        void lock;
        void run();
      };

      if (this.current === null) {
        this.activate(holder);
      } else {
        this.waiters.push(holder);
      }
    });
  }

  private activate(holder: Holder): void {
    this.current = holder;
    holder.grant({ lost: holder.controller.signal });
  }

  /** 抢占：让当前持有者立即收到 abort（失锁），队列首位随后获锁 */
  steal(): void {
    const victim = this.current;
    if (!victim) return;
    this.current = null;
    victim.controller.abort();
    const next = this.waiters.shift();
    if (next) {
      // 微任务延迟：保证旧持有者先处理 abort
      queueMicrotask(() => {
        if (this.current === null) this.activate(next);
      });
    }
  }
}

type Handler = (msg: StageMessage) => void;

/** BroadcastChannel 内存网络：同网互通，消息不回送发送者 */
export class FakeChannelNetwork {
  private members = new Set<FakeChannel>();

  join(ch: FakeChannel): void {
    this.members.add(ch);
  }
  leave(ch: FakeChannel): void {
    this.members.delete(ch);
  }
  deliver(sender: FakeChannel, msg: StageMessage): void {
    for (const m of [...this.members]) {
      if (m !== sender) m.deliver(msg);
    }
  }
}

export class FakeChannel {
  private handler: Handler | null = null;
  constructor(private network: FakeChannelNetwork) {
    network.join(this);
  }
  post(msg: StageMessage): void {
    this.network.deliver(this, msg);
  }
  onMessage(handler: Handler): void {
    this.handler = handler;
  }
  deliver(msg: StageMessage): void {
    this.handler?.(msg);
  }
  close(): void {
    this.network.leave(this);
  }
}
