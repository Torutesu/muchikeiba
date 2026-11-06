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
            ["VERIFIER_UNAVAILABLE"] = ApiErrorCode.VerifierUnavailable,
            ["INTERNAL"] = ApiErrorCode.Internal,
        };

        public static IReadOnlyCollection<string> WireCodes => ByWire.Keys;

        public static ApiErrorCode Parse(string wire) => wire != null && ByWire.TryGetValue(wire, out var c) ? c : ApiErrorCode.Unknown;

        /// <summary>Builds the typed exception for a server error.</summary>
        public static ApiException Create(string wire, string message, int status)
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
                    return new PurchaseBlockedException(code, wire, message, status);
                case ApiErrorCode.InsufficientCoins:
                    return new InsufficientCoinsException(wire, message, status);
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

    /// <summary>Not enough coins: show the shop.</summary>
    public sealed class InsufficientCoinsException : ApiException
    {
        public InsufficientCoinsException(string wire, string message, int status) : base(ApiErrorCode.InsufficientCoins, wire, message, status) { }
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
