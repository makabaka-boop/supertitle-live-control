// 全局共享类型：节目单、持久化画面、控制者身份。

export type CueKind = 'subtitle' | 'blackout';

/** 一条提示：双语字幕（中/意原文）或黑场提示 */
export interface Cue {
  id: string;
  kind: CueKind;
  zh: string;
  it: string;
}

/** 已冻结的在演节目单（“采用节目单”时生成深拷贝快照） */
export interface StoredProgram {
  id: string;
  adoptedAt: number;
  cues: Cue[];
}

/** 发布到投影的一帧画面；同代次内 seq 单调递增 */
export interface Frame {
  generation: number;
  seq: number;
  kind: CueKind;
  cueId: string | null;
  cueIndex: number;
  zh: string;
  it: string;
  programId: string;
  controllerId: string;
  controllerName: string;
  publishedAt: number;
}

export interface ControllerInfo {
  id: string;
  name: string;
}
