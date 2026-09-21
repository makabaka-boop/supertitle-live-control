// Web Locks 封装：跨页面（含投影页、其他控制页）竞争同一把排他锁。
// 胜者才是唯一有效操控者；持锁页面崩溃 / 关闭时浏览器自动释放，
// 等待队列中的下一个页面获得回调并接管。

export const LOCK_NAME = 'opera-stage-controller';

export type LockState = 'idle' | 'waiting' | 'leader';

export interface StageLockEvents {
  /** 获得锁，成为当前唯一控制者。 */
  granted(): void;
  /**
   * 锁丢失（页面被回收、steal、或主动 release）。
   * 本页必须立即禁用一切操控动作；迟到消息在投影侧由代次栅栏拦截。
   */
  lost(): void;
}

export class StageLock {
  state: LockState = 'idle';
  private release: (() => void) | null = null;
  private released = false;

  constructor(private readonly events: StageLockEvents) {}

  /**
   * 进入竞争队列。若当前已有持锁者，则保持 waiting 直到其释放。
   * 不使用 ifAvailable —— 要求是“排队等接管”，而不是抢不到就退出。
   */
  async acquire(): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'waiting';
    this.released = false;

    await navigator.locks.request(
      LOCK_NAME,
      // 独占模式（默认），同一时刻全源只有一个 granted。
      () =>
        new Promise<void>((resolve) => {
          if (this.released) {
            // release() 在 granted 前就被调用的极端时序。
            resolve();
            return;
          }
          this.release = resolve;
          this.state = 'leader';
          try {
            this.events.granted();
          } catch {
            // 事件回调异常不能把锁卡死：清理状态并让外层统一走 lost。
            this.release = null;
            this.state = 'idle';
            resolve();
          }
        }),
    );

    // Promise 结束 = 锁已离开本页（主动释放或浏览器回收）。
    this.state = 'idle';
    this.release = null;
    this.events.lost();
  }

  /** 主动交权（例如“退场交权”按钮或页面卸载）。 */
  async releaseLock(): Promise<void> {
    this.released = true;
    const r = this.release;
    this.release = null;
    if (r) r();
  }

  get isLeader(): boolean {
    return this.state === 'leader';
  }
}

/** 查询当前锁占用情况（诊断用：列出持锁 / 等待者）。 */
export async function queryLock(): Promise<LockManagerSnapshot | null> {
  if (typeof navigator === 'undefined' || !navigator.locks?.query) {
    return null;
  }
  return navigator.locks.query();
}
