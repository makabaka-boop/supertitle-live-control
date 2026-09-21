/**
 * 运行环境端口：Web Locks 与 BroadcastChannel 的浏览器适配层。
 * engine 只依赖这些接口，单元测试可注入内存假实现来模拟多页争用。
 */

import type { Frame } from '../types';

export interface StageLock {
  /** 锁被抢占（steal）或失效时触发 */
  readonly lost: AbortSignal;
}

export interface LockManagerLike {
  /**
   * 请求唯一锁。callback 执行期间持有锁；callback 返回的 Promise 落定即释放。
   * 实现必须在拿到锁之后再调用 callback，且其他同名请求排队等待。
   */
  request(
    name: string,
    callback: (lock: StageLock) => Promise<void>,
  ): Promise<void>;
}

export class BrowserLockManager implements LockManagerLike {
  async request(
    name: string,
    callback: (lock: StageLock) => Promise<void>,
  ): Promise<void> {
    // mode 默认 exclusive：同名锁全队列互斥，保证舞台上只有一个有效操控者。
    await navigator.locks.request(name, { mode: 'exclusive' }, async () => {
      const controller = new AbortController();

      // Web Locks 规范不为“持锁被抢占”提供直接事件；
      // 持锁期间轮询 query()：锁消失或持有者 clientId 变化即判定失锁。
      // （页面关闭时回调随之销毁，无需此处处理。）
      let ownClientId: string | null = null;
      const poll = window.setInterval(async () => {
        try {
          const snapshot = await navigator.locks.query();
          const held = snapshot.held ?? [];
          const holder = held.find((l) => l.name === name);
          if (!holder) {
            controller.abort();
            return;
          }
          if (ownClientId === null) {
            ownClientId = holder.clientId ?? null;
          } else if (holder.clientId !== ownClientId) {
            controller.abort();
          }
        } catch {
          // 查询失败不做致命处理，下一轮再试。
        }
      }, 250);

      try {
        await callback({ lost: controller.signal });
      } finally {
        window.clearInterval(poll);
      }
    });
  }
}

/** 发布给其它页面的消息；永远只携带“已确认落库”的帧 */
export interface FrameMessage {
  type: 'frame';
  frame: Frame;
}

export type StageMessage = FrameMessage;

export interface StageChannel {
  post(message: StageMessage): void;
  onMessage(handler: (message: StageMessage) => void): void;
  close(): void;
}

export class BrowserStageChannel implements StageChannel {
  private channel: BroadcastChannel;
  private handler: ((message: StageMessage) => void) | null = null;

  constructor(name = 'opera-stage') {
    this.channel = new BroadcastChannel(name);
    this.channel.onmessage = (ev: MessageEvent<StageMessage>) => {
      this.handler?.(ev.data);
    };
  }

  post(message: StageMessage): void {
    this.channel.postMessage(message);
  }

  onMessage(handler: (message: StageMessage) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.channel.close();
  }
}
