/** 練習レース (§50): ids shared by practice.ts and the KPI schema (kept dependency-free, like nextKinds.ts). */
export const PRACTICE_ID_RE = /^[a-z][a-z0-9_]{0,15}$/;
/** KPI `practice_start.restart` (§50.10). */
export const PRACTICE_RESTARTS = ['none', 'same_seed', 'new_seed'] as const;
