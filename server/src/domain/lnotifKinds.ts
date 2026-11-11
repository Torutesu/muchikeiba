/**
 * REQ-LNOTIF-001/013 (contracts/protocol.md §61): the local notification kinds and the permission answers, in a module
 * with no imports so kpi.ts can validate client events without pulling in localNotify.ts (which reads nextAction.ts).
 */
/** The local kinds, highest priority first (the daily cap keeps the first ones). */
export const LNOTIF_KINDS = ['training_session', 'gift_expiring', 'exchange_closing', 'weekly_challenge_closing', 'rival_week_closing', 'daily_bonus'] as const;
export type LnotifKind = (typeof LNOTIF_KINDS)[number];
/** lnotif_permission results: the OS answer, or `later` when the pre-prompt was put off. */
export const LNOTIF_PERMISSION_RESULTS = ['granted', 'provisional', 'denied', 'later'] as const;
