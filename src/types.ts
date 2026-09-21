// 核心领域模型与线协议类型。
// 所有跨页面 / 跨会话传递的数据都必须可结构化克隆（IndexedDB、BroadcastChannel）。

/** 单条节目单条目：双语字幕或黑场提示。 */
export interface Cue {
  id: string;
  /** 条目种类：subtitle=双语字幕，blackout=黑场提示。 */
  kind: 'subtitle' | 'blackout';
  /** 原文行（例如意大利语）。blackout 时可为空串。 */
  source: string;
  /** 译文行（例如中文）。blackout 时可为空串。 */
  translation: string;
  /** 舞台备注，仅控制端可见。 */
  note: string;
}

/** 编辑器中的节目单草稿。 */
export interface ProgramDraft {
  cues: Cue[];
  /** 单调递增的草稿版本号，仅用于编辑器自身。 */
  draftRev: number;
  updatedAt: number;
}

/**
 * 冻结的在演节目单。一旦“采用节目单”，后续编辑只改草稿，不动本对象。
 * frozenAt 记录冻结时刻。
 */
export interface FrozenProgram {
  cues: Cue[];
  frozenAt: number;
}

/**
 * 代次（generation）：每次控制者成功“开演/接管”时递增。
 * 控制者标识 controllerId 在同一代次内不变；换页接管必然产生新代次。
 */
export interface ControllerInfo {
  controllerId: string;
  /** 人类可读标签，便于舞台监督辨认。 */
  label: string;
}

/** 当前投影画面内容。null 条目表示尚未显示任何句子（开场等待）。 */
export interface FrameContent {
  kind: 'subtitle' | 'blackout';
  cueId: string | null;
  source: string;
  translation: string;
}

/**
 * 持久化的“已确认画面”。
 * generation/sequence 为代次栅栏：投影只接受 (gen 更高) 或 (gen 相同且 seq 更大)。
 */
export interface FrameState {
  generation: number;
  sequence: number;
  controllerId: string;
  controllerLabel: string;
  content: FrameContent;
  /** 本次画面确认写入的时间戳。 */
  publishedAt: number;
}

/** IndexedDB 中持久化的整体演出状态。 */
export interface PersistedState {
  draft: ProgramDraft;
  frozen: FrozenProgram | null;
  frame: FrameState | null;
}

/** BroadcastChannel 消息种类。 */
export type WireMessage =
  | {
      type: 'frame';
      /** 与 FrameState 同构，避免接收端再查库；库内记录是最终依据。 */
      frame: FrameState;
    }
  | {
      type: 'controller';
      /** 当前持锁控制者信息，随心跳广播；null 表示控制者已退场。 */
      controller: (ControllerInfo & { generation: number }) | null;
      /** 退场消息携带本页代次，旧代次的退场不得清掉新代次控制者。 */
      generation?: number;
    };

/** 能力探测结果：任一必需能力缺失时允许编辑但禁止开演。 */
export interface CapabilityReport {
  indexedDB: boolean;
  webLocks: boolean;
  broadcastChannel: boolean;
  structuredClone: boolean;
  missing: string[];
}
