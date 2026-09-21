/**
 * StageEngine —— 舞台运行时核心。
 *
 * 不变式：
 * 1. 只有持有唯一 Web Lock 的页面（leader）可以发布；开演时在同一 IndexedDB
 *    事务内取得递增代次并落第一帧（黑场），事务提交后才经 BroadcastChannel 发布。
 * 2. 切句/黑场：同一事务核对“当前帧的控制者与代次”，seq+1 落库成功后再广播。
 *    写入失败只报错，本地与投影都保留上一幅已确认帧（从不乐观更新）。
 * 3. 投影/从页只接受“更高代次，或同代次更大 seq”的帧；迟到的旧代次消息被丢弃。
 * 4. leader 失锁立即禁用（role='lost'），之后任何操作都被拒绝。
 */

import {
  StaleControlError,
  acquireGeneration,
  getFrame,
  publishNextFrame,
} from './db';
import type {
  LockManagerLike,
  StageChannel,
  StageMessage,
} from './ports';
import type { Cue, ControllerInfo, Frame } from '../types';

export type StageRole = 'idle' | 'waiting' | 'leader' | 'follower' | 'lost';

export interface StageState {
  role: StageRole;
  /** 本机当前确认的画面（来自事务返回值、广播仲裁或持久化读取） */
  frame: Frame | null;
  busy: boolean;
  error: string | null;
  /** 开演所依据的节目单（仅用于控制者取词） */
  programId: string | null;
  controller: ControllerInfo | null;
}

export type StateListener = (state: StageState) => void;

export interface EngineDeps {
  locks: LockManagerLike;
  channel: StageChannel;
  /** 注入 IDBFactory；浏览器中留空使用全局 indexedDB */
  idbFactory?: IDBFactory;
  now?: () => number;
}

const LOCK_NAME = 'opera-stage-control';

export function isNewerFrame(candidate: Frame, current: Frame | null): boolean {
  if (!current) return true;
  if (candidate.generation !== current.generation) {
    return candidate.generation > current.generation;
  }
  return candidate.seq > current.seq;
}

export class StageEngine {
  private state: StageState = {
    role: 'idle',
    frame: null,
    busy: false,
    error: null,
    programId: null,
    controller: null,
  };
  private listeners = new Set<StateListener>();
  /** 持有锁期间用于主动释放（resolve 回调 Promise） */
  private releaseResolve: (() => void) | null = null;
  private stopped = false;

  constructor(private deps: EngineDeps) {
    this.deps.channel.onMessage((msg) => this.handleMessage(msg));
  }

  getState(): StageState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private patch(partial: Partial<StageState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }

  /** 页面启动时读取持久画面（投影页重开后恢复） */
  async init(): Promise<void> {
    try {
      const frame = await getFrame(this.deps.idbFactory);
      if (frame && isNewerFrame(frame, this.state.frame)) {
        this.patch({ frame });
      }
    } catch (err) {
      this.patch({ error: `读取持久画面失败：${describe(err)}` });
    }
  }

  /**
   * 请求开演/接管。锁被他人持有时排队等待（role='waiting'）；
   * 持锁者关闭页面 → 队列头部自动获锁并成为新代次控制者。
   */
  async start(controller: ControllerInfo, programId: string): Promise<void> {
    if (this.state.role === 'leader' || this.state.role === 'waiting') return;
    this.patch({
      role: 'waiting',
      error: null,
      programId,
      controller,
    });

    try {
      await this.deps.locks.request(LOCK_NAME, async (lock) => {
        if (this.stopped) return;
        lock.lost.addEventListener('abort', () => this.handleLostLock(), {
          once: true,
        });
        await this.becomeLeader(controller, programId);
        // Promise 保持 pending 直到主动 release() 或页面销毁 —— 即持续持锁。
        await new Promise<void>((resolve) => {
          this.releaseResolve = resolve;
        });
      });
    } catch (err) {
      this.patch({
        role: 'idle',
        busy: false,
        error: `未能取得控制权：${describe(err)}`,
      });
      return;
    }

    // 主动释放后回到只读从页，可再次 start() 接管。
    if (!this.stopped && this.state.role !== 'lost') {
      this.patch({ role: 'follower' });
    }
  }

  /** 获锁后：同事务递增代次 + 发布起始黑场帧 */
  private async becomeLeader(
    controller: ControllerInfo,
    programId: string,
  ): Promise<void> {
    this.patch({ busy: true, error: null });
    try {
      const frame = await acquireGeneration(
        controller,
        programId,
        this.deps.now ? this.deps.now() : Date.now(),
        this.deps.idbFactory,
      );
      // 事务已提交：先成为确认画面，再发布。
      this.patch({ role: 'leader', frame, busy: false });
      this.deps.channel.post({ type: 'frame', frame });
    } catch (err) {
      this.patch({
        busy: false,
        error: `接管失败，未取得代次：${describe(err)}`,
      });
      throw err; // 让锁回调失败并释放锁
    }
  }

  private handleLostLock(): void {
    // 失锁旧页立即禁用；迟到的发布将因 role!=='leader' 被拒，
    // 即便其事务侥幸提交，投影也以更高代次拒绝其消息。
    if (this.state.role === 'lost') return;
    this.releaseResolve?.();
    this.releaseResolve = null;
    this.patch({ role: 'lost', busy: false });
  }

  /** 主动放弃控制（不关闭页面） */
  releaseControl(): void {
    if (this.state.role !== 'leader') return;
    this.releaseResolve?.();
    this.releaseResolve = null;
    this.patch({ role: 'follower' });
  }

  /** 切到某条字幕 */
  async showCue(cue: Cue, cueIndex: number): Promise<void> {
    await this.publish({
      kind: 'subtitle',
      cueId: cue.id,
      cueIndex,
      zh: cue.zh,
      it: cue.it,
    });
  }

  /** 黑场 */
  async blackout(): Promise<void> {
    await this.publish({
      kind: 'blackout',
      cueId: null,
      cueIndex: -1,
      zh: '',
      it: '',
    });
  }

  private async publish(
    patch: Pick<Frame, 'kind' | 'cueId' | 'cueIndex' | 'zh' | 'it'>,
  ): Promise<void> {
    const { role, frame, controller, programId, busy } = this.state;
    if (busy) return;
    if (role === 'lost') {
      this.patch({ error: '控制权已丢失，操作被拒绝。' });
      return;
    }
    if (role !== 'leader' || !frame || !controller || !programId) {
      this.patch({ error: '当前不是有效控制者，无法发布画面。' });
      return;
    }

    this.patch({ busy: true, error: null });
    try {
      // 同一事务核对控制者与代次、seq+1、落库；提交前不触碰本地画面。
      const confirmed = await publishNextFrame(
        {
          ...patch,
          generation: frame.generation,
          programId,
          controllerId: controller.id,
          controllerName: controller.name,
        },
        this.deps.now ? this.deps.now() : Date.now(),
        this.deps.idbFactory,
      );
      // 落库成功：确认画面 + 广播（绝不先报成功）。
      this.patch({ frame: confirmed, busy: false });
      this.deps.channel.post({ type: 'frame', frame: confirmed });
    } catch (err) {
      if (err instanceof StaleControlError) {
        // 代次/控制者已被新接管者取代 → 本页立刻失效。
        this.patch({
          role: 'lost',
          busy: false,
          error: `控制者或代次已变更，本页已被禁用：${err.message}`,
        });
      } else {
        // 写入失败：保持上一幅确认画面并报错。
        this.patch({
          busy: false,
          error: `画面写入失败，仍保持上一幅画面：${describe(err)}`,
        });
      }
    }
  }

  private handleMessage(msg: StageMessage): void {
    if (msg.type !== 'frame') return;
    // 投影页与从页（含已失锁旧页）统一仲裁：只接受更高代次/同代次更大序号。
    if (isNewerFrame(msg.frame, this.state.frame)) {
      this.patch({
        frame: msg.frame,
        role: this.state.role === 'idle' ? 'follower' : this.state.role,
      });
    }
  }

  destroy(): void {
    this.stopped = true;
    this.releaseResolve?.();
    this.releaseResolve = null;
    this.deps.channel.close();
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
