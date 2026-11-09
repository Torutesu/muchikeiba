/**
 * REQ-NEXT-001: the kinds of the home's 次にやること card (contracts/protocol.md §45.1), in the tie-break order of §45.1.
 * A module of its own so kpi.ts can name them without importing the guide's dependencies (nextAction.ts re-exports it).
 */
export const NEXT_KINDS = [
  'first_race', 'login_bonus', 'missions_claim', 'pass_claim', 'gift_expiring', 'training_open', 'missions_close', 'exchange_closing',
  'feature_unlocked', 'rival_week', 'weekly_challenge', 'team_goal_near', 'training_slots', 'first_win', 'scout_ticket', 'race',
] as const;
export type NextKind = typeof NEXT_KINDS[number];
/** Where a card was shown: the primary card or one of the chips. */
export const NEXT_SLOTS = ['primary', 'chip'] as const;
