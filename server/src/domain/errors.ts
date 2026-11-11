/** Machine-readable error codes (REQ-API-004). */
export type ErrorCode =
  | 'BAD_REQUEST' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'CONFLICT' | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INSUFFICIENT_COINS' | 'UNSETTLED_DEBT' | 'AGE_REQUIRED' | 'GUARDIAN_CONSENT_REQUIRED'
  | 'AGE_LIMIT_EXCEEDED' | 'ALREADY_PURCHASED' | 'UNKNOWN_PRODUCT' | 'RECEIPT_INVALID'
  | 'BANNER_CLOSED' | 'TUTORIAL_GACHA_USED' | 'PITY_INSUFFICIENT' | 'INVALID_NAME' | 'NG_NAME'
  | 'HORSE_NOT_FOUND' | 'HORSE_NOT_ACTIVE' | 'HORSE_NOT_RETIRED' | 'BREEDING_INVALID_PAIR'
  | 'BREEDING_DAILY_LIMIT' | 'AWAKENING_MAX' | 'ALREADY_CLAIMED' | 'NOT_ELIGIBLE'
  | 'ALREADY_QUEUED' | 'NOT_IN_QUEUE' | 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'NOT_HOST' | 'CONFIG_INVALID'
  | 'FRIEND_LIMIT' | 'ALREADY_IN_RACE' | 'ROOM_TOO_SMALL' | 'FORBIDDEN' | 'RATE_LIMITED' | 'BANNED'
  | 'TA_LIMIT_REACHED' | 'TA_SESSION_EXPIRED' | 'TA_SESSION_USED' | 'TA_CONFIG_MISMATCH' | 'TA_RESULT_MISMATCH' | 'VERIFIER_UNAVAILABLE'
  | 'ALREADY_IN_TEAM' | 'NOT_IN_TEAM' | 'TEAM_FULL' | 'TEAM_COOLDOWN' | 'TEAM_LIMIT' | 'TEAM_LEADER_MUST_TRANSFER'
  | 'EVENT_CLOSED' | 'INSUFFICIENT_ITEMS' | 'COOLDOWN' | 'FEE_CHANGED'
  | 'LIKE_LIMIT' | 'ALREADY_LIKED'
  | 'CONSENT_VERSION_MISMATCH' | 'PARTNER_ALREADY_GRANTED' | 'DELETION_CONFIRM_INVALID' | 'DELETION_PENDING' | 'DELETION_IN_PROGRESS'
  | 'STAMP_LOCKED'
  | 'INVITE_CODE_INVALID' | 'INVITE_SELF' | 'INVITE_ALREADY_REDEEMED' | 'INVITE_WINDOW_CLOSED' | 'INVITE_REFUSED'
  | 'AD_LIMIT_REACHED'
  | 'TRAINING_LIMIT' | 'TRAINING_TIRED' | 'TRAINING_POTENTIAL_FULL' | 'TRAINING_SESSION_EXPIRED' | 'TRAINING_SESSION_USED' | 'TRAINING_INPUT_INVALID'
  | 'GIFT_EXPIRED' | 'GIFT_HOLD_CAP'
  | 'RIVAL_CHALLENGE_LIMIT'
  | 'EXCHANGE_NOT_OPEN' | 'EXCHANGE_CLOSED' | 'OUT_OF_STOCK' | 'INSUFFICIENT_POINTS'
  | 'CHALLENGE_LIMIT_REACHED' | 'CHALLENGE_HORSE_INELIGIBLE' | 'CHALLENGE_SESSION_EXPIRED' | 'CHALLENGE_SESSION_USED' | 'CHALLENGE_RESULT_MISMATCH'
  | 'REPLAY_LIMIT' | 'REPLAY_EXPIRED' | 'REPLAY_TOO_LARGE'
  | 'PHOTO_LIMIT' | 'PHOTO_LOCKED' | 'PHOTO_SOURCE_INVALID'
  | 'HORSE_LOCKED' | 'ROSTER_BULK_REFUSED' | 'ROSTER_BULK_STALE'
  | 'CUP_LIMIT' | 'CUP_FULL' | 'CUP_CLOSED' | 'CUP_CODE_INVALID' | 'CUP_NOT_READY'
  | 'MAINTENANCE' | 'UPGRADE_REQUIRED'
  | 'DATA_EXPORT_COOLDOWN' | 'LINK_INVALID' | 'LINK_EXPIRED'
  | 'TRANSFER_INVALID' | 'TRANSFER_EXPIRED' | 'TRANSFER_LOCKED' | 'TRANSFER_PASSWORD_WEAK' | 'TRANSFER_CONFIRM_REQUIRED' | 'TRANSFER_SAME_ACCOUNT'
  | 'TRANSFER_REFUSED' | 'TRANSFER_ISSUE_LIMIT' | 'SESSION_REPLACED';

const STATUS: Partial<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400, CONFIG_INVALID: 500, UNAUTHORIZED: 401, NOT_FOUND: 404, HORSE_NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404, UNKNOWN_PRODUCT: 404, IDEMPOTENCY_KEY_REQUIRED: 400, INVALID_NAME: 400, NG_NAME: 400,
  FORBIDDEN: 403, BANNED: 403, RATE_LIMITED: 429,
  TA_CONFIG_MISMATCH: 400, TA_RESULT_MISMATCH: 422, VERIFIER_UNAVAILABLE: 503,
  NOT_IN_TEAM: 404, INVITE_CODE_INVALID: 400, TRAINING_INPUT_INVALID: 422, CHALLENGE_RESULT_MISMATCH: 422, CHALLENGE_LIMIT_REACHED: 429,
  REPLAY_EXPIRED: 410, REPLAY_TOO_LARGE: 413,
  PHOTO_SOURCE_INVALID: 400,
  CUP_CODE_INVALID: 404,
  // REQ-MNT-003/006 (§46): a maintenance window covers the endpoint / the app is below the supported version
  MAINTENANCE: 503, UPGRADE_REQUIRED: 426,
  // REQ-DEX-* (§51): one request per cooldown; a download link that does not verify / has expired
  DATA_EXPORT_COOLDOWN: 429, LINK_INVALID: 403, LINK_EXPIRED: 410,
  // REQ-TRF-* (§54): 引き継ぎコード. SESSION_REPLACED = this device's session was moved to another device (never retried)
  TRANSFER_INVALID: 400, TRANSFER_EXPIRED: 410, TRANSFER_LOCKED: 429, TRANSFER_PASSWORD_WEAK: 400, TRANSFER_CONFIRM_REQUIRED: 409,
  TRANSFER_SAME_ACCOUNT: 409, TRANSFER_REFUSED: 403, TRANSFER_ISSUE_LIMIT: 429, SESSION_REPLACED: 401,
};

export class AppError extends Error {
  readonly status: number;
  /**
   * Structured data for the client, sent as `error.details` (REQ-SHORT-004: INSUFFICIENT_COINS carries
   * `{ coinKind, need, have }` from the wallet and `shortfall` added by the service). Absent on other errors.
   */
  details?: Record<string, unknown>;
  constructor(readonly code: ErrorCode, message?: string, status?: number, details?: Record<string, unknown>) {
    super(message ?? code);
    this.status = status ?? STATUS[code] ?? 409;
    if (details) this.details = details;
  }
}

/** REQ-SHORT-001: what the wallet says about a coin spend it refused (`have` = the coins that may pay for it). */
export interface CoinNeed { coinKind: 'any' | 'paid' | 'free'; need: number; have: number }
export function insufficientCoins(n: CoinNeed, message?: string): AppError {
  return new AppError('INSUFFICIENT_COINS', message ?? `need ${n.need}${n.coinKind === 'any' ? '' : ` ${n.coinKind} coins`}, have ${n.have}`, undefined, { ...n });
}

export function assert(cond: unknown, code: ErrorCode, message?: string): asserts cond {
  if (!cond) throw new AppError(code, message);
}
