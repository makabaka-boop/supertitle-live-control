/** 能力探测：任一项缺失时仍允许编辑节目单，但禁止开演，并列明缺项。 */

export interface CapabilityReport {
  locks: boolean;
  indexedDb: boolean;
  broadcastChannel: boolean;
}

export function detectCapabilities(): CapabilityReport {
  return {
    locks:
      typeof globalThis.navigator !== 'undefined' &&
      'locks' in globalThis.navigator &&
      typeof globalThis.navigator.locks?.request === 'function',
    indexedDb:
      typeof globalThis.indexedDB !== 'undefined' &&
      typeof globalThis.indexedDB.open === 'function',
    broadcastChannel: typeof globalThis.BroadcastChannel === 'function',
  };
}

export const CAPABILITY_LABELS: Record<keyof CapabilityReport, string> = {
  locks: 'Web Locks（唯一控制者锁）',
  indexedDb: 'IndexedDB（代次与画面持久化）',
  broadcastChannel: 'BroadcastChannel（画面实时发布）',
};

export function missingCapabilities(report: CapabilityReport): string[] {
  return (Object.keys(report) as (keyof CapabilityReport)[])
    .filter((k) => !report[k])
    .map((k) => CAPABILITY_LABELS[k]);
}
