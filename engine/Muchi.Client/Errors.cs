using System;
using System.Collections.Generic;

namespace Muchi.Client
{
    /// <summary>Every error code the server emits (server/src/domain/errors.ts, plus INTERNAL from the router).</summary>
    public enum ApiErrorCode
    {
        Unknown = 0,
        BadRequest, Unauthorized, NotFound, Conflict, IdempotencyKeyRequired,
        InsufficientCoins, UnsettledDebt, AgeRequired, GuardianConsentRequired,
        AgeLimitExceeded, AlreadyPurchased, UnknownProduct, ReceiptInvalid,
        BannerClosed, TutorialGachaUsed, PityInsufficient, InvalidName, NgName,
        HorseNotFound, HorseNotActive, HorseNotRetired, BreedingInvalidPair,
        BreedingDailyLimit, AwakeningMax, AlreadyClaimed, NotEligible,
        AlreadyQueued, NotInQueue, RoomNotFound, RoomFull, NotHost, ConfigInvalid,
        FriendLimit, AlreadyInRace, RoomTooSmall,
        /// <summary>403: the account is banned (racing and purchases disabled).</summary>
        Banned,
        /// <summary>403 / 429: admin-only codes; never expected by the game client.</summary>
        Forbidden, RateLimited,
        TaLimitReached, TaSessionExpired, TaSessionUsed, TaConfigMismatch, TaResultMismatch, VerifierUnavailable,
        AlreadyInTeam, NotInTeam, TeamFull, TeamCooldown, TeamLimit, TeamLeaderMustTransfer,
        EventClosed, InsufficientItems,
        /// <summary>409: a care action is still cooling down or today's care limit is reached (REQ-BOND-002).</summary>
        Cooldown,
        /// <summary>409: the stud fee changed since the borrower's preview; nothing was charged (REQ-BREED-012).</summary>
        FeeChanged,
        /// <summary>409: today's stable likes are used up (REQ-STABLE-005; likes never give coins).</summary>
        LikeLimit,
        /// <summary>409: this stable was already liked today.</summary>
        AlreadyLiked,
        /// <summary>409: the consent was for an old terms/privacy version; refetch /v1/player consent.current (REQ-UXS-001).</summary>
        ConsentVersionMismatch,
        /// <summary>409: the first partner horse was already granted (REQ-UXS-002).</summary>
        PartnerAlreadyGranted,
        /// <summary>409: the account deletion token is wrong or expired; request a new one (REQ-UXS-040).</summary>
        DeletionConfirmInvalid,
        /// <summary>409: the account is scheduled for deletion; purchases are disabled until it is cancelled (REQ-UXS-040).</summary>
        DeletionPending,
        /// <summary>409: the deletion run has already started and cannot be cancelled any more (REQ-UXS-040).</summary>
        DeletionInProgress,
        /// <summary>409: this team-feed stamp is not unlocked yet; show Stamp.UnlockText (REQ-TEAMFEED-002).</summary>
        StampLocked,
        /// <summary>400: not an invite code (typo; the check symbol did not match). REQ-INV-003.</summary>
        InviteCodeInvalid,
        /// <summary>409: the player entered their own invite code.</summary>
        InviteSelf,
        /// <summary>409: this account already entered an invite code (one per account).</summary>
        InviteAlreadyRedeemed,
        /// <summary>409: the days for entering an invite code are over (redeemWindowDays after install).</summary>
        InviteWindowClosed,
        /// <summary>409: the code cannot be used from this account or device (anti-abuse; show a neutral message).</summary>
        InviteRefused,
        /// <summary>409: today's rewarded-ad views for that placement (or overall) are used up (REQ-AD-008).</summary>
        AdLimitReached,
        /// <summary>409: today's training slots (or this horse's sessions today) are used up (REQ-TRAIN-001).</summary>
        TrainingLimit,
        /// <summary>409: the horse is tired; only プール or a rest day (or a training item) (REQ-TRAIN-009).</summary>
        TrainingTired,
        /// <summary>409: the horse has grown to its potential (REQ-TRAIN-004).</summary>
        TrainingPotentialFull,
        /// <summary>409: the training session expired; it was settled as skipped (REQ-TRAIN-002).</summary>
        TrainingSessionExpired,
        /// <summary>409: no open training session with this id (already finished or replaced).</summary>
        TrainingSessionUsed,
        /// <summary>422: the submitted taps break the mini-game bounds (REQ-TRAIN-007).</summary>
        TrainingInputInvalid,
        /// <summary>409: the gift box entry has expired (REQ-BOX-006).</summary>
        GiftExpired,
        /// <summary>409: receiving this gift would go over a hold limit (coins or items); it stays in the box (REQ-BOX-005).</summary>
        GiftHoldCap,
        /// <summary>REQ-RIVAL-008: too many ライバルと走る challenges today (409).</summary>
        RivalChallengeLimit,
        /// <summary>409: the event's exchange has not opened yet (REQ-EXCH-005).</summary>
        ExchangeNotOpen,
        /// <summary>409: the exchange closed; leftover points were converted into material (REQ-EXCH-006).</summary>
        ExchangeClosed,
        /// <summary>409: this exchange line has no stock left for the player (REQ-EXCH-008).</summary>
        OutOfStock,
        /// <summary>409: not enough event points (REQ-EXCH-008).</summary>
        InsufficientPoints,
        ChallengeLimitReached,
        ChallengeHorseIneligible,
        ChallengeSessionExpired,
        ChallengeSessionUsed,
        ChallengeResultMismatch,
        /// <summary>409: at most `maxSaved` photo records (REQ-PHOTO-010).</summary>
        PhotoLimit,
        /// <summary>409: a look / frame / stamp that is not unlocked (REQ-PHOTO-011).</summary>
        PhotoLocked,
        /// <summary>400: a race run with other people cannot be paused (REQ-PHOTO-001).</summary>
        PhotoSourceInvalid,
        Internal,
        /// <summary>No response (network failure) after all retries.</summary>
        Network,
    }

    public static class ApiErrorCodes
    {
        private static readonly Dictionary<string, ApiErrorCode> ByWire = new Dictionary<string, ApiErrorCode>
        {
            ["BAD_REQUEST"] = ApiErrorCode.BadRequest,
            ["UNAUTHORIZED"] = ApiErrorCode.Unauthorized,
            ["NOT_FOUND"] = ApiErrorCode.NotFound,
            ["CONFLICT"] = ApiErrorCode.Conflict,
            ["IDEMPOTENCY_KEY_REQUIRED"] = ApiErrorCode.IdempotencyKeyRequired,
            ["INSUFFICIENT_COINS"] = ApiErrorCode.InsufficientCoins,
            ["UNSETTLED_DEBT"] = ApiErrorCode.UnsettledDebt,
            ["AGE_REQUIRED"] = ApiErrorCode.AgeRequired,
            ["GUARDIAN_CONSENT_REQUIRED"] = ApiErrorCode.GuardianConsentRequired,
            ["AGE_LIMIT_EXCEEDED"] = ApiErrorCode.AgeLimitExceeded,
            ["ALREADY_PURCHASED"] = ApiErrorCode.AlreadyPurchased,
            ["UNKNOWN_PRODUCT"] = ApiErrorCode.UnknownProduct,
            ["RECEIPT_INVALID"] = ApiErrorCode.ReceiptInvalid,
            ["BANNER_CLOSED"] = ApiErrorCode.BannerClosed,
            ["TUTORIAL_GACHA_USED"] = ApiErrorCode.TutorialGachaUsed,
            ["PITY_INSUFFICIENT"] = ApiErrorCode.PityInsufficient,
            ["INVALID_NAME"] = ApiErrorCode.InvalidName,
            ["NG_NAME"] = ApiErrorCode.NgName,
            ["HORSE_NOT_FOUND"] = ApiErrorCode.HorseNotFound,
            ["HORSE_NOT_ACTIVE"] = ApiErrorCode.HorseNotActive,
            ["HORSE_NOT_RETIRED"] = ApiErrorCode.HorseNotRetired,
            ["BREEDING_INVALID_PAIR"] = ApiErrorCode.BreedingInvalidPair,
            ["BREEDING_DAILY_LIMIT"] = ApiErrorCode.BreedingDailyLimit,
            ["AWAKENING_MAX"] = ApiErrorCode.AwakeningMax,
            ["ALREADY_CLAIMED"] = ApiErrorCode.AlreadyClaimed,
            ["NOT_ELIGIBLE"] = ApiErrorCode.NotEligible,
            ["ALREADY_QUEUED"] = ApiErrorCode.AlreadyQueued,
            ["NOT_IN_QUEUE"] = ApiErrorCode.NotInQueue,
            ["ROOM_NOT_FOUND"] = ApiErrorCode.RoomNotFound,
            ["ROOM_FULL"] = ApiErrorCode.RoomFull,
            ["NOT_HOST"] = ApiErrorCode.NotHost,
            ["CONFIG_INVALID"] = ApiErrorCode.ConfigInvalid,
            ["FRIEND_LIMIT"] = ApiErrorCode.FriendLimit,
            ["ALREADY_IN_RACE"] = ApiErrorCode.AlreadyInRace,
            ["ROOM_TOO_SMALL"] = ApiErrorCode.RoomTooSmall,
            ["BANNED"] = ApiErrorCode.Banned,
            ["FORBIDDEN"] = ApiErrorCode.Forbidden,
            ["RATE_LIMITED"] = ApiErrorCode.RateLimited,
            ["TA_LIMIT_REACHED"] = ApiErrorCode.TaLimitReached,
            ["TA_SESSION_EXPIRED"] = ApiErrorCode.TaSessionExpired,
            ["TA_SESSION_USED"] = ApiErrorCode.TaSessionUsed,
            ["TA_CONFIG_MISMATCH"] = ApiErrorCode.TaConfigMismatch,
            ["TA_RESULT_MISMATCH"] = ApiErrorCode.TaResultMismatch,
            ["ALREADY_IN_TEAM"] = ApiErrorCode.AlreadyInTeam,
            ["NOT_IN_TEAM"] = ApiErrorCode.NotInTeam,
            ["TEAM_FULL"] = ApiErrorCode.TeamFull,
            ["TEAM_COOLDOWN"] = ApiErrorCode.TeamCooldown,
            ["TEAM_LIMIT"] = ApiErrorCode.TeamLimit,
            ["TEAM_LEADER_MUST_TRANSFER"] = ApiErrorCode.TeamLeaderMustTransfer,
            ["EVENT_CLOSED"] = ApiErrorCode.EventClosed,
            ["INSUFFICIENT_ITEMS"] = ApiErrorCode.InsufficientItems,
            ["COOLDOWN"] = ApiErrorCode.Cooldown,
            ["FEE_CHANGED"] = ApiErrorCode.FeeChanged,
            ["LIKE_LIMIT"] = ApiErrorCode.LikeLimit,
            ["ALREADY_LIKED"] = ApiErrorCode.AlreadyLiked,
            ["CONSENT_VERSION_MISMATCH"] = ApiErrorCode.ConsentVersionMismatch,
            ["PARTNER_ALREADY_GRANTED"] = ApiErrorCode.PartnerAlreadyGranted,
            ["DELETION_CONFIRM_INVALID"] = ApiErrorCode.DeletionConfirmInvalid,
            ["DELETION_PENDING"] = ApiErrorCode.DeletionPending,
            ["DELETION_IN_PROGRESS"] = ApiErrorCode.DeletionInProgress,
            ["STAMP_LOCKED"] = ApiErrorCode.StampLocked,
            ["INVITE_CODE_INVALID"] = ApiErrorCode.InviteCodeInvalid,
            ["INVITE_SELF"] = ApiErrorCode.InviteSelf,
            ["INVITE_ALREADY_REDEEMED"] = ApiErrorCode.InviteAlreadyRedeemed,
            ["INVITE_WINDOW_CLOSED"] = ApiErrorCode.InviteWindowClosed,
            ["INVITE_REFUSED"] = ApiErrorCode.InviteRefused,
            ["AD_LIMIT_REACHED"] = ApiErrorCode.AdLimitReached,
            ["TRAINING_LIMIT"] = ApiErrorCode.TrainingLimit,
            ["TRAINING_TIRED"] = ApiErrorCode.TrainingTired,
            ["TRAINING_POTENTIAL_FULL"] = ApiErrorCode.TrainingPotentialFull,
            ["TRAINING_SESSION_EXPIRED"] = ApiErrorCode.TrainingSessionExpired,
            ["TRAINING_SESSION_USED"] = ApiErrorCode.TrainingSessionUsed,
            ["TRAINING_INPUT_INVALID"] = ApiErrorCode.TrainingInputInvalid,
            ["GIFT_EXPIRED"] = ApiErrorCode.GiftExpired,
            ["GIFT_HOLD_CAP"] = ApiErrorCode.GiftHoldCap,
            ["RIVAL_CHALLENGE_LIMIT"] = ApiErrorCode.RivalChallengeLimit,
            ["EXCHANGE_NOT_OPEN"] = ApiErrorCode.ExchangeNotOpen,
            ["EXCHANGE_CLOSED"] = ApiErrorCode.ExchangeClosed,
            ["OUT_OF_STOCK"] = ApiErrorCode.OutOfStock,
            ["INSUFFICIENT_POINTS"] = ApiErrorCode.InsufficientPoints,
            ["CHALLENGE_LIMIT_REACHED"] = ApiErrorCode.ChallengeLimitReached,
            ["CHALLENGE_HORSE_INELIGIBLE"] = ApiErrorCode.ChallengeHorseIneligible,
            ["CHALLENGE_SESSION_EXPIRED"] = ApiErrorCode.ChallengeSessionExpired,
            ["CHALLENGE_SESSION_USED"] = ApiErrorCode.ChallengeSessionUsed,
            ["CHALLENGE_RESULT_MISMATCH"] = ApiErrorCode.ChallengeResultMismatch,
            ["PHOTO_LIMIT"] = ApiErrorCode.PhotoLimit,
            ["PHOTO_LOCKED"] = ApiErrorCode.PhotoLocked,
            ["PHOTO_SOURCE_INVALID"] = ApiErrorCode.PhotoSourceInvalid,
            ["VERIFIER_UNAVAILABLE"] = ApiErrorCode.VerifierUnavailable,
            ["INTERNAL"] = ApiErrorCode.Internal,
        };

        public static IReadOnlyCollection<string> WireCodes => ByWire.Keys;

        public static ApiErrorCode Parse(string wire) => wire != null && ByWire.TryGetValue(wire, out var c) ? c : ApiErrorCode.Unknown;

        /// <summary>Builds the typed exception for a server error.</summary>
        public static ApiException Create(string wire, string message, int status) => Create(wire, message, status, null);

        /// <summary>Builds the typed exception; <paramref name="details"/> is the error's optional <c>details</c> object (REQ-SHORT-004).</summary>
        public static ApiException Create(string wire, string message, int status, Muchi.Net.JsonNode details)
        {
            var code = Parse(wire);
            switch (code)
            {
                case ApiErrorCode.Unauthorized:
                    return new AuthException(wire, message, status);
                case ApiErrorCode.BadRequest:
                case ApiErrorCode.IdempotencyKeyRequired:
                case ApiErrorCode.InvalidName:
                case ApiErrorCode.NgName:
                case ApiErrorCode.TaConfigMismatch:
                case ApiErrorCode.InviteCodeInvalid:
                case ApiErrorCode.TrainingInputInvalid:
                    return new ValidationException(code, wire, message, status);
                case ApiErrorCode.NotFound:
                case ApiErrorCode.HorseNotFound:
                case ApiErrorCode.RoomNotFound:
                case ApiErrorCode.NotInTeam:
                case ApiErrorCode.UnknownProduct:
                    return new NotFoundException(code, wire, message, status);
                case ApiErrorCode.AgeRequired:
                case ApiErrorCode.GuardianConsentRequired:
                case ApiErrorCode.AgeLimitExceeded:
                case ApiErrorCode.AlreadyPurchased:
                case ApiErrorCode.UnsettledDebt:
                case ApiErrorCode.DeletionPending:
                    return new PurchaseBlockedException(code, wire, message, status);
                case ApiErrorCode.InsufficientCoins:
                    return new InsufficientCoinsException(wire, message, status, CoinShortfall.Parse(J.Opt(details, "shortfall")));
                case ApiErrorCode.RateLimited:
                    return new RateLimitedException(wire, message, status);
                case ApiErrorCode.Internal:
                case ApiErrorCode.ConfigInvalid:
                case ApiErrorCode.VerifierUnavailable:
                    return new ServerException(code, wire, message, status);
                default:
                    if (status >= 500) return new ServerException(code, wire, message, status);
                    return new ConflictException(code, wire, message, status);
            }
        }
    }

    /// <summary>Base of every API failure. <see cref="Code"/> is the typed code, <see cref="WireCode"/> the raw string.</summary>
    public class ApiException : Exception
    {
        public ApiErrorCode Code { get; }
        public string WireCode { get; }
        /// <summary>HTTP status (0 for network errors).</summary>
        public int Status { get; }

        public ApiException(ApiErrorCode code, string wireCode, string message, int status, Exception inner = null)
            : base(message ?? wireCode, inner)
        {
            Code = code; WireCode = wireCode; Status = status;
        }
    }

    /// <summary>401: sign in again.</summary>
    public sealed class AuthException : ApiException
    {
        public AuthException(string wire, string message, int status) : base(ApiErrorCode.Unauthorized, wire, message, status) { }
    }

    /// <summary>400: the request was malformed or a value was rejected (e.g. NG_NAME). Fix the input, do not retry.</summary>
    public sealed class ValidationException : ApiException
    {
        public ValidationException(ApiErrorCode c, string wire, string message, int status) : base(c, wire, message, status) { }
    }

    public sealed class NotFoundException : ApiException
    {
        public NotFoundException(ApiErrorCode c, string wire, string message, int status) : base(c, wire, message, status) { }
    }

    /// <summary>The purchase must not start: age not registered, consent missing, monthly limit, once-only product, unsettled refund.</summary>
    public sealed class PurchaseBlockedException : ApiException
    {
        public PurchaseBlockedException(ApiErrorCode c, string wire, string message, int status) : base(c, wire, message, status) { }
    }

    /// <summary>
    /// Not enough coins. <see cref="Shortfall"/> (REQ-SHORT-004): which coins, how many, and the one pack to offer (T6, shown by
    /// Muchi.Game CoinShortfallModel); null from an older server or a shortage that is not the wallet's (show the shop).
    /// </summary>
    public sealed class InsufficientCoinsException : ApiException
    {
        public CoinShortfall Shortfall { get; }
        public InsufficientCoinsException(string wire, string message, int status, CoinShortfall shortfall = null) : base(ApiErrorCode.InsufficientCoins, wire, message, status) { Shortfall = shortfall; }
    }

    /// <summary>409-style game rule rejections (ALREADY_CLAIMED, BREEDING_DAILY_LIMIT, ROOM_FULL ...).</summary>
    public sealed class ConflictException : ApiException
    {
        public ConflictException(ApiErrorCode c, string wire, string message, int status) : base(c, wire, message, status) { }
    }

    /// <summary>429 RATE_LIMITED (e.g. analytics ingestion quota). Back off before sending again.</summary>
    public sealed class RateLimitedException : ApiException
    {
        public RateLimitedException(string wire, string message, int status) : base(ApiErrorCode.RateLimited, wire, message, status) { }
    }

    public sealed class ServerException : ApiException
    {
        public ServerException(ApiErrorCode c, string wire, string message, int status) : base(c, wire, message, status) { }
    }

    /// <summary>No response from the server after all retries.</summary>
    public sealed class NetworkException : ApiException
    {
        public NetworkException(string message, Exception inner) : base(ApiErrorCode.Network, "NETWORK", message, 0, inner) { }
    }
}
