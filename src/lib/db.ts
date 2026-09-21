/**
 * IndexedDB 持久化层。
 *
 * 单对象仓库 `meta`：
 *   key 'program'  StoredProgram  已冻结在演节目单
 *   key 'frame'    Frame          当前已确认画面（先写后发，见 engine）
 *   key 'counter'  { generation: number }  唯一控制者代次计数器
 *
 * 唯一控制者代次的“递增”与画面落库都必须在同一个 IndexedDB 事务内完成；
 * IndexedDB 的 readonly/readwrite 事务由调度器保证串行化提交，
 * 因此即使多页面同时获胜（真实 Web Locks 下不会发生，测试锁下会），
 * 代次也不会重复。
 */

const DB_NAME = 'opera-stage';
const DB_VERSION = 1;
const STORE = 'meta';

import type { ControllerInfo, Frame, StoredProgram } from '../types';

export interface GenerationCounter {
  generation: number;
}

export class StaleControlError extends Error {
  constructor(
    public expectedGeneration: number,
    actualGeneration: number,
    public expectedControllerId: string,
    actualControllerId: string,
  ) {
    super(
      `控制者/代次校验失败：期望 g${expectedGeneration} ${expectedControllerId}，` +
        `实际 g${actualGeneration} ${actualControllerId}`,
    );
    this.name = 'StaleControlError';
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(factory?: IDBFactory): Promise<IDBDatabase> {
  const idb = factory ?? globalThis.indexedDB;
  if (!idb) {
    return Promise.reject(new Error('IndexedDB 不可用'));
  }
  if (!factory && dbPromise) {
    return dbPromise;
  }
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
  if (!factory) {
    dbPromise = promise;
  }
  return promise;
}

/** 仅供单元测试使用：重置模块级连接缓存 */
export function _resetDbCache(): void {
  dbPromise = null;
}

function txPromise<T>(
  tx: IDBTransaction,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = work(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
    tx.onabort = () => reject(tx.error ?? req.error ?? new Error('IndexedDB 事务中止'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
  });
}

function txRequest<T>(fn: () => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = fn();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
  });
}

export async function getProgram(factory?: IDBFactory): Promise<StoredProgram | undefined> {
  const db = await openDb(factory);
  const tx = db.transaction(STORE, 'readonly');
  return txPromise(tx, (s) => s.get('program') as IDBRequest<StoredProgram | undefined>);
}

export async function saveProgram(
  program: StoredProgram,
  factory?: IDBFactory,
): Promise<void> {
  const db = await openDb(factory);
  const tx = db.transaction(STORE, 'readwrite');
  await txPromise(tx, (s) => s.put(program, 'program'));
}

export async function getFrame(factory?: IDBFactory): Promise<Frame | undefined> {
  const db = await openDb(factory);
  const tx = db.transaction(STORE, 'readonly');
  return txPromise(tx, (s) => s.get('frame') as IDBRequest<Frame | undefined>);
}

/**
 * 接管舞台（唯一生效控制者）：同一事务内
 * 读取当前代次计数 -> +1 -> 写入起始黑场帧 -> 提交。
 * 事务提交（调用方收到 await）后，帧才算“已确认”，方可广播。
 */
export async function acquireGeneration(
  controller: ControllerInfo,
  programId: string,
  now: number,
  factory?: IDBFactory,
): Promise<Frame> {
  const db = await openDb(factory);
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  const counter = await txRequest<GenerationCounter | undefined>(() =>
    store.get('counter'),
  );
  const generation = (counter?.generation ?? 0) + 1;
  const frame: Frame = {
    generation,
    seq: 0,
    kind: 'blackout',
    cueId: null,
    cueIndex: -1,
    zh: '',
    it: '',
    programId,
    controllerId: controller.id,
    controllerName: controller.name,
    publishedAt: now,
  };
  await txRequest(() => store.put({ generation }, 'counter'));
  await txRequest(() => store.put(frame, 'frame'));
  await txDone(tx);
  return frame;
}

/**
 * 发布下一帧（切句/黑场）：同一事务内核对控制者与代次，
 * 只有仍是当前帧标注的控制者且代次一致时，才允许 seq+1 覆盖画面。
 * 校验不通过抛 StaleControlError；任何写入失败抛错，旧帧保持不变。
 */
export async function publishNextFrame(
  next: Omit<Frame, 'seq' | 'publishedAt'>,
  now: number,
  factory?: IDBFactory,
): Promise<Frame> {
  const db = await openDb(factory);
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  const current = await txRequest<Frame | undefined>(() => store.get('frame'));
  if (
    !current ||
    current.generation !== next.generation ||
    current.controllerId !== next.controllerId
  ) {
    tx.abort();
    throw new StaleControlError(
      next.generation,
      current?.generation ?? -1,
      next.controllerId,
      current?.controllerId ?? '(无)',
    );
  }
  const frame: Frame = {
    ...next,
    seq: current.seq + 1,
    publishedAt: now,
  };
  await txRequest(() => store.put(frame, 'frame'));
  await txDone(tx);
  return frame;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
  });
}
