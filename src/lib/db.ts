// IndexedDB 封装。所有演出状态写入均以单事务完成，失败即整体回滚，
// 调用方据此保留“上一幅已确认画面”，绝不出现先成功后回退。

import type {
  FrameContent,
  FrameState,
  FrozenProgram,
  ProgramDraft,
} from '../types';

const DB_NAME = 'opera-prompter';
const DB_VERSION = 1;
const STORE = 'kv';

const KEY_DRAFT = 'draft';
const KEY_FROZEN = 'frozen';
const KEY_FRAME = 'frame';
const KEY_META = 'meta';

interface KvRecord<T> {
  key: string;
  value: T;
}

interface Meta {
  /** 已使用的最大代次；每次开演/接管在事务内 +1。 */
  generation: number;
}

/** 调用方代次过期（已有新控制者开演）。 */
export class StaleGenerationError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`代次已过期：本页持有第 ${expected} 代，当前为第 ${actual} 代`);
    this.name = 'StaleGenerationError';
  }
}

/** 调用方已不是本代次的唯一控制者。 */
export class ControllerMismatchError extends Error {
  constructor() {
    super('控制者校验失败：本页已不再是当前有效操控者');
    this.name = 'ControllerMismatchError';
  }
}

/** 尚无冻结节目单，不能开演。 */
export class NoFrozenProgramError extends Error {
  constructor() {
    super('尚未采用节目单，不能开演');
    this.name = 'NoFrozenProgramError';
  }
}

/** 节目单为空，不能采用。 */
export class EmptyProgramError extends Error {
  constructor() {
    super('节目单为空，不能采用');
    this.name = 'EmptyProgramError';
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const cached: Promise<IDBDatabase> = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const invalidate = () => {
          if (dbPromise === cached) dbPromise = null;
        };
        // 其他页面请求删除 / 升级数据库时主动让路，避免 deleteDatabase 永久 blocked。
        db.onversionchange = () => {
          db.close();
          invalidate();
        };
        db.onclose = invalidate;
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () =>
        reject(new Error('数据库被其他标签页阻塞，请关闭旧页面后重试'));
    });
    dbPromise = cached;
  }
  return dbPromise;
}

function txPromise<T>(
  tx: IDBTransaction,
  work: () => T | Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error('事务已中止'));
    tx.onerror = () => reject(tx.error ?? new Error('事务出错'));
    try {
      const maybe = work();
      if (maybe instanceof Promise) {
        maybe.then(
          (v) => {
            result = v;
          },
          (err) => {
            try {
              tx.abort();
            } catch {
              /* 已中止则忽略 */
            }
            reject(err);
          },
        );
      } else {
        result = maybe;
      }
    } catch (err) {
      try {
        tx.abort();
      } catch {
        /* 同上 */
      }
      reject(err);
    }
  });
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getValue<T>(store: IDBObjectStore, key: string): Promise<T | undefined> {
  return reqAsPromise(store.get(key) as IDBRequest<KvRecord<T> | undefined>).then(
    (rec) => rec?.value,
  );
}

function putValue<T>(store: IDBObjectStore, key: string, value: T): void {
  store.put({ key, value } satisfies KvRecord<T>);
}

export function newEmptyDraft(now: number = Date.now()): ProgramDraft {
  return { cues: [], draftRev: 0, updatedAt: now };
}

async function readDraft(store: IDBObjectStore): Promise<ProgramDraft> {
  return (await getValue<ProgramDraft>(store, KEY_DRAFT)) ?? newEmptyDraft();
}

/** 读取全部持久状态（单一只读事务）。 */
export async function loadPersisted(): Promise<{
  draft: ProgramDraft;
  frozen: FrozenProgram | null;
  frame: FrameState | null;
}> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return txPromise(tx, async () => ({
    draft: await readDraft(store),
    frozen: (await getValue<FrozenProgram>(store, KEY_FROZEN)) ?? null,
    frame: (await getValue<FrameState>(store, KEY_FRAME)) ?? null,
  }));
}

/** 保存草稿。绝不触碰冻结版本与画面。 */
export async function saveDraft(draft: ProgramDraft): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  putValue(store, KEY_DRAFT, draft);
  await txPromise(tx, () => undefined);
}

/**
 * 采用节目单：把当前草稿的快照冻结为在演版本。
 * 空节目单拒绝；之后草稿再被编辑不影响已冻结快照。
 */
export async function adoptProgram(cues: ProgramDraft['cues']): Promise<FrozenProgram> {
  if (cues.length === 0) {
    throw new EmptyProgramError();
  }
  const snapshot: FrozenProgram = {
    cues: cues.map((c) => ({ ...c })),
    frozenAt: Date.now(),
  };
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  putValue(store, KEY_FROZEN, snapshot);
  await txPromise(tx, () => undefined);
  return snapshot;
}

export interface StartResult {
  generation: number;
  frame: FrameState;
}

/**
 * 开演 / 接管：单事务内
 *   1) 校验已采用节目单；
 *   2) 读取并递增代次；
 *   3) 写入本代次第 0 号画面。
 *      首次开演为黑场等待；接管时由调用方传入上一代画面作为起点，
 *      保证接管瞬间不闪黑。
 * 事务失败则全部不生效，调用方不能自认为控制者。
 */
export async function startPerformance(
  controller: { id: string; label: string },
  opts: { initialContent?: FrameContent; now?: number } = {},
): Promise<StartResult> {
  const now = opts.now ?? Date.now();
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  return txPromise(tx, async () => {
    const frozen = await getValue<FrozenProgram>(store, KEY_FROZEN);
    if (!frozen || frozen.cues.length === 0) {
      throw new NoFrozenProgramError();
    }
    const meta = (await getValue<Meta>(store, KEY_META)) ?? { generation: 0 };
    const generation = meta.generation + 1;
    putValue(store, KEY_META, { generation } satisfies Meta);

    const content: FrameContent =
      opts.initialContent ??
      ({
        kind: 'blackout',
        cueId: null,
        source: '',
        translation: '',
      } satisfies FrameContent);

    const frame: FrameState = {
      generation,
      sequence: 0,
      controllerId: controller.id,
      controllerLabel: controller.label,
      content,
      publishedAt: now,
    };
    putValue(store, KEY_FRAME, frame);
    return { generation, frame };
  });
}

/**
 * 发布下一幅画面（切句 / 黑场）。同一读写事务内：
 *   - 核对持久代次 == 调用方代次（防旧页覆盖新代次）；
 *   - 核对当前画面控制者 == 调用方（唯一操控者）；
 *   - 序号 +1 并整帧写入。
 * 任一步失败事务回滚，库内仍为上一幅确认画面，错误向上抛出由 UI 报错。
 */
export async function publishFrame(args: {
  controllerId: string;
  generation: number;
  content: FrameContent;
  now?: number;
}): Promise<FrameState> {
  const { controllerId, generation, content } = args;
  const now = args.now ?? Date.now();
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  return txPromise(tx, async () => {
    const meta = (await getValue<Meta>(store, KEY_META)) ?? { generation: 0 };
    if (meta.generation !== generation) {
      throw new StaleGenerationError(generation, meta.generation);
    }
    const current = await getValue<FrameState>(store, KEY_FRAME);
    if (
      !current ||
      current.controllerId !== controllerId ||
      current.generation !== generation
    ) {
      throw new ControllerMismatchError();
    }
    const next: FrameState = {
      generation,
      sequence: current.sequence + 1,
      controllerId,
      controllerLabel: current.controllerLabel,
      content,
      publishedAt: now,
    };
    putValue(store, KEY_FRAME, next);
    return next;
  });
}

/** 单独读取最近一次已确认画面（投影页重开时调用）。 */
export async function loadFrame(): Promise<FrameState | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return txPromise(
    tx,
    async () => (await getValue<FrameState>(store, KEY_FRAME)) ?? null,
  );
}

/** 仅测试使用：重置数据库。 */
export async function _resetDatabaseForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('删除数据库被阻塞'));
  });
}
