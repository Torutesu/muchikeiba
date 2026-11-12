/**
 * KPI events: essential vs optional (REQ-CNS-012/013, contracts/protocol.md §58.7).
 *
 * `essential` events are kept whatever the player chose for analytics: they are the records the operator has to keep or
 * needs to prevent fraud (資金決済法 / refunds, paid coin use, ad network reconciliation, consent proof, data subject
 * rights, safety reports and support). Everything else is `optional` analytics and is NOT written to Analytics Engine
 * while the player's analytics choice is off (privacyChoices.ts). A name missing from the table counts as optional
 * (when unsure, do not send); test/privacy-choices.test.ts collects every event name the code emits and fails on an
 * unclassified one.
 */
import type { KpiRecord } from './kpi.js';

export type KpiClass = 'essential' | 'optional';

/** Essential events and why (the reason is documentation; docs/planning/03-legal-risk.md §58 lists them for review). */
export const KPI_ESSENTIAL: Readonly<Record<string, string>> = Object.freeze({
  purchase: 'payment record (資金決済法, store reconciliation)',
  refund: 'refund record',
  pass_renew: 'payment record (season pass renewal)',
  pass_status: 'subscription state record',
  gacha_draw: 'may spend paid coins (prepaid instrument use record)',
  silks_part_buy: 'may spend paid coins (prepaid instrument use record)',
  commentary_pack_buy: 'may spend paid coins (prepaid instrument use record)',
  ad_reward: 'ad network reconciliation and fraud prevention (SSV grants)',
  ad_reject: 'fraud prevention (rejected SSV callbacks)',
  consent: 'proof of terms / privacy policy consent',
  consent_change: 'proof of the ad / analytics choices (§58)',
  account_delete: 'data subject right (deletion) record',
  dex_request: 'data subject right (disclosure) record',
  dex_ready: 'data subject right (disclosure) record',
  dex_download: 'data subject right (disclosure) record',
  report_submit: 'safety record (player reports)',
  block_add: 'safety record (blocks)',
  block_remove: 'safety record (blocks)',
  inquiry_submit: 'support record',
  inquiry_answered: 'support record',
  // Round 23 §73.8: the support thread — when the player wrote, when a ticket reopened and when it closed are the support
  // trail ops need for refunds and complaints (SLA proof); the rows carry the category and status only, never the text
  ticket_player_reply: 'support record (player message in a ticket, §73)',
  ticket_reopen: 'support record (ticket reopened, §73)',
  ticket_resolved: 'support record (ticket resolved / closed / auto-closed, §73)',
  // R20 integration: Round 19 §54 引き継ぎコード — account access like sign-in; the issue / redeem rows (with the failure class,
  // never the ID or password) are the audit trail ops need to spot brute force and account takeover (§54.9)
  transfer_issue: 'account access audit (transfer code issued, §54)',
  transfer_redeem: 'account access audit and brute-force detection (transfer code redeemed / failed, §54)',
});

/** Every other event name the server emits or accepts from clients: optional analytics. */
export const KPI_OPTIONAL: readonly string[] = Object.freeze([
  // server
  'a11y_setting_change', 'ab_assign', 'achievement_claim', 'achievement_unlock', 'assist_disable', 'assist_enable', 'assist_prompt_view',
  'challenge_clear', 'challenge_start', 'comeback_complete', 'comeback_day', 'comeback_start', 'commentary_pack_equip', 'cup_create',
  'cup_finish', 'cup_join', 'event_entry', 'event_point_earn', 'exchange_buy', 'first_open', 'friend_accept', 'friend_request',
  'fsug_dismiss', 'fsug_request', 'gift_claim', 'gift_expire', 'gift_receive', 'help_feedback', 'hgoal_complete', 'hgoal_pin',
  'hof_induct', 'hof_view', 'invite_milestone', 'invite_redeem', 'login_bonus', 'next_card_dismiss', 'partner_granted', 'photo_save',
  'qchat_post', 'qchat_react', 'race_assisted', 'race_finish', 'recap_complete', 'recap_open', 'replay_save', 'replay_view', 'rival_opt',
  'rival_race', 'rival_view', 'rival_week_result', 'roster_bulk_action', 'season_close', 'silks_edit', 'stable_like', 'stable_save',
  'stable_visit', 'stamp_post', 'stud_breed', 'team_feed_view', 'team_goal_contribute', 'team_goal_milestone', 'team_goal_reward',
  'team_join', 'team_leave', 'training_done', 'training_start', 'tutorial_gacha',
  // R20 integration: §59 レビュー依頼 (server rows of an engagement prompt)
  'review_prompt_eligible', 'review_prompt_shown', 'review_soft_answer',
  // client (POST /v1/analytics/events, after clientToKpi)
  'session_start', 'session_end', 'tutorial_step', 'screen_view', 'commentary_pack_sample', 'client_race_start', 'purchase_flow',
  'push_open', 'push_permission', 'feature_unlock', 'offer_view', 'offer_click', 'race_quit', 'account_link', 'share', 'invite_share',
  'replay_share', 'roster_sort', 'recap_share', 'ad_offer_view', 'ad_start', 'history_view', 'advice_view', 'advice_follow', 'photo_take',
  'photo_share', 'activity_open', 'activity_tap', 'maintenance_block', 'upgrade_prompt', 'next_card_view', 'next_card_tap', 'help_search',
  'help_article_view', 'fsug_view', 'hgoal_view', 'practice_start', 'practice_finish',
  // R20 integration: Round 19 §55 応援 / §56 画質・通信量 / §57 ヒント and Round 20 §61 端末のローカル通知 — engagement only
  'cheer_send', 'cheer_seen', 'perf_setting_change', 'asset_predownload', 'tutorial_replay', 'tip_view', 'tip_context_open',
  'lnotif_scheduled', 'lnotif_opened', 'lnotif_permission',
  // R21 integration: §62 トレーナーカード, §63 ディープリンク・再戦, §64 アップデートのお知らせ, §65 予定表 — engagement only
  // (no payment, legal or account-access record among them; link rows never carry a token, a target or an id)
  'showcase_save', 'showcase_view', 'showcase_share',
  'link_create', 'link_resolve', 'link_revoke', 'rematch', 'deep_link_open',
  'release_notes_view', 'release_notes_target', 'release_notes_history',
  'calendar_view', 'calendar_entry_open', 'calendar_mark',
  // R23 §73: opening a support reply (engagement only; the reply itself is the support record)
  'ticket_reply_view',
]);

export const KPI_EVENT_CLASS: Readonly<Record<string, KpiClass>> = Object.freeze({
  ...Object.fromEntries(KPI_OPTIONAL.map((n) => [n, 'optional' as const])),
  ...Object.fromEntries(Object.keys(KPI_ESSENTIAL).map((n) => [n, 'essential' as const])),
});

/** Unknown names are optional (fail closed for privacy). */
export const kpiClassOf = (name: string): KpiClass => KPI_EVENT_CLASS[name] ?? 'optional';
export const isEssentialKpi = (name: string) => kpiClassOf(name) === 'essential';

/** REQ-CNS-013: the records that may be written for a player whose optional analytics are allowed (or not). */
export function filterKpi<T extends Pick<KpiRecord, 'name'>>(records: T[], optionalAllowed: boolean): { kept: T[]; withheld: number } {
  if (optionalAllowed) return { kept: records, withheld: 0 };
  const kept = records.filter((r) => isEssentialKpi(r.name));
  return { kept, withheld: records.length - kept.length };
}
