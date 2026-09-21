// 跨页面会话：BroadcastChannel 实时分发 + IndexedDB 持久真相。
// 所有“画面”一律先在事务中确认入库，提交成功后才广播；
// 接收端按代次栅栏 (isNewerFrame) 判定，迟到旧消息无法覆盖新画面。

import type { FrameContent, FrameState, WireMessage } from '../types';
import {
  isControllerAtLeast,
  isNewerFrame,
  shouldClearController,
} from './protocol';
import { StageLock } from './locks';
import {
  loadFrame,
  publishFrame as dbPublishFrame,
  startPerformance,
} from './db';

export const CHANNEL_NAME = 'opera-stage-bus';
const HEARTBEAT_MS = 1000;

export interface ActiveController {
  controllerId: string;
  label: string;
  generation: number;
}

export type ViewerStatus =
  | { role: 'viewer'; controller: ActiveController | null }
  | { role: 'waiting'; controller: ActiveController | null }
  | {
      role: 'leader';
      generation: number;
      controllerId: string;
      label: string;
    }
  | { role: 'lost'; generation: number };

export interface SessionSnapshot {
  status: ViewerStatus;
  frame: FrameState | null;
  error: string | null;
}

type Listener = (snapshot: SessionSnapshot) => void;

export interface ControllerIdentity {
  id: string;
  label: string;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 生成新的控制者身份（每次打开控制页）。 */
export function createIdentity(label: string): ControllerIdentity {
  return { id: randomId(), label };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

type BusFactory = () => BroadcastChannel;
const defaultBusFactory: BusFactory = () =>
  new BroadcastChannel(CHANNEL_NAME);

export abstract class BaseSession {
  protected snapshot: SessionSnapshot = {
    status: { role: 'viewer', controller: null },
    frame: null,
    error: null,
  };
  protected bus: BroadcastChannel | null;
  private listeners = new Set<Listener>();

  constructor(busFactory: BusFactory) {
    this.bus = busFactory();
    this.bus.onmessage = (ev: MessageEvent<WireMessage>) =>
      this.onWire(ev.data);
    this.bus.onmessageerror = () =>
      this.emit({ error: '收到无法反序列化的消息，已忽略' });
  }

  protected emit(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l(this.snapshot);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => {
      this.listeners.delete(fn);
    };
  }

  get current(): SessionSnapshot {
    return this.snapshot;
  }

  protected send(msg: WireMessage): void {
    // postMessage 失败不影响已确认的持久状态，仅报错。
    try {
      this.bus?.postMessage(msg);
    } catch (err) {
      this.emit({
        error: `画面广播失败（持久状态已保存，投影重开仍会读到）：${describe(err)}`,
      });
    }
  }

  protected abstract onWire(msg: WireMessage): void;

  /** 从 IndexedDB 读取上一幅已确认画面（页面打开 / 重开时）。 */
  async hydrateFrame(): Promise<void> {
    try {
      const frame = await loadFrame();
      if (frame && isNewerFrame(this.snapshot.frame, frame)) {
        this.emit({ frame });
      }
    } catch (err) {
      this.emit({ error: `读取已确认画面失败：${describe(err)}` });
    }
  }

  dispose(): void {
    this.bus?.close();
    this.bus = null;
  }
}

/**
 * 投影 / 观众会话：只读。
 * 进入时以持久状态为准；之后只接受代次更高、或同代次序号更大的帧。
 */
export class ViewerSession extends BaseSession {
  constructor(busFactory: BusFactory = defaultBusFactory) {
    super(busFactory);
  }

  /** 重开 / 首次进入：以持久状态为最终真相，无条件采用已确认画面。 */
  async hydrateFromStorage(): Promise<void> {
    await this.hydrateFrame();
  }

  protected onWire(msg: WireMessage): void {
    if (msg.type === 'frame') {
      // 代次栅栏：更高代次 或 同代次更大序号才接受。
      if (isNewerFrame(this.snapshot.frame, msg.frame)) {
        this.emit({ frame: msg.frame });
      }
      return;
    }

    const status = this.snapshot.status;
    if (status.role !== 'viewer' && status.role !== 'waiting') return;

    if (msg.controller === null) {
      const currentGen = status.controller?.generation ?? null;
      const nullGen = msg.generation;
      // 旧代次的退场消息不能清掉新代次控制者。
      if (nullGen === undefined || shouldClearController(currentGen, nullGen)) {
        this.emit({ status: { role: status.role, controller: null } });
      }
      return;
    }

    if (
      !status.controller ||
      isControllerAtLeast(status.controller.generation, msg.controller.generation)
    ) {
      this.emit({
        status: { role: status.role, controller: msg.controller },
      });
    }
  }
}

/**
 * 控制会话：竞争唯一锁。胜者在同一事务里取得新代次、发布初始画面；
 * 失锁立即禁用，之后任何 publish 都会被本地状态与事务代次双重拦截。
 */
export class ControllerSession extends BaseSession {
  private lock: StageLock;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private identity: ControllerIdentity;
  private generation = 0;

  constructor(
    identity: ControllerIdentity,
    busFactory: BusFactory = defaultBusFactory,
  ) {
    super(busFactory);
    this.identity = identity;
    this.emit({ status: { role: 'waiting', controller: null } });

    this.lock = new StageLock({
      granted: () => void this.onGranted(),
      lost: () => this.onLost(),
    });
  }

  /** 进入竞争队列；已有持锁者时持续等待，其释放后自动接管。 */
  async enterContention(): Promise<void> {
    await this.lock.acquire();
  }

  private async onGranted(): Promise<void> {
    // 接管时把上一代最后一幅已确认画面作为新代次起点，避免接管瞬间闪黑。
    let seed: FrameState | null = null;
    try {
      seed = await loadFrame();
    } catch {
      seed = null;
    }

    try {
      const result = await startPerformance(this.identity, {
        initialContent: seed?.content,
      });
      this.generation = result.generation;

      // 事务提交成功：持久真相先成立，再对外发布。
      this.emit({ frame: result.frame, error: null });
      this.send({ type: 'frame', frame: result.frame });
      this.emit({
        status: {
          role: 'leader',
          generation: this.generation,
          controllerId: this.identity.id,
          label: this.identity.label,
        },
      });
      this.announceController();
      this.heartbeat = setInterval(
        () => this.announceController(),
        HEARTBEAT_MS,
      );
    } catch (err) {
      // 开演事务失败：没有合法代次，放弃锁并报错，绝不当自己是控制者。
      this.emit({ error: `开演失败：${describe(err)}` });
      await this.lock.releaseLock();
    }
  }

  private onLost(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    // 立即禁用：状态切 lost，UI 所有操控按钮失效。
    const lostGen = this.generation;
    this.generation = 0;
    this.emit({ status: { role: 'lost', generation: lostGen } });
    // 携带本页代次退场：旧代次的退场不会清掉更新代次的新控制者。
    this.send({
      type: 'controller',
      controller: null,
      generation: lostGen,
    });
  }

  /**
   * 切句 / 黑场：同一事务核对控制者与代次、递增序号并保存画面，
   * 提交成功后才经 BroadcastChannel 发布。
   * 失败时库内仍是上一幅确认画面，错误上抛给 UI 显示。
   */
  async publish(content: FrameContent): Promise<FrameState> {
    if (!this.lock.isLeader || this.generation === 0) {
      throw new Error('本页已失去控制权，不能操控画面');
    }
    const next = await dbPublishFrame({
      controllerId: this.identity.id,
      generation: this.generation,
      content,
    });
    // 到此处事务已提交；先更新本地，再广播。
    this.emit({ frame: next, error: null });
    this.send({ type: 'frame', frame: next });
    return next;
  }

  /** 主动交权（“退场交权”按钮或页面卸载）。 */
  async standDown(): Promise<void> {
    await this.lock.releaseLock();
  }

  isLeader(): boolean {
    return this.lock.isLeader;
  }

  private announceController(): void {
    if (!this.lock.isLeader || this.generation === 0) return;
    this.send({
      type: 'controller',
      controller: {
        controllerId: this.identity.id,
        label: this.identity.label,
        generation: this.generation,
      },
    });
  }

  protected onWire(msg: WireMessage): void {
    // 等待接管期间也显示当前画面与在任控制者。
    if (msg.type === 'frame') {
      if (isNewerFrame(this.snapshot.frame, msg.frame)) {
        this.emit({ frame: msg.frame });
      }
      return;
    }
    const status = this.snapshot.status;
    if (status.role === 'waiting') {
      if (msg.controller) {
        this.emit({
          status: { role: 'waiting', controller: msg.controller },
        });
      }
    }
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    super.dispose();
    void this.lock.releaseLock();
  }
}
