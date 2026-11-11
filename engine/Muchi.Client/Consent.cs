using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // 広告・分析の同意管理 (REQ-CNS-001..020, contracts/protocol.md §58, server/src/domain/privacyChoices.ts).
    // The server keeps the player's choices (personalised ads / analytics), the privacy policy version they were made under
    // and what the OS decided (ATT on iOS, UMP / CMP in the EEA), and works out what applies. The client reads it, shows
    // the pre-prompt at the moment the server names, asks the OS through IConsentPlatform (Codex implements the native
    // calls, docs/handoff-codex-round20-consent.md) and reports the result. Refusing never costs a reward or a feature.

    /// <summary>iOS App Tracking Transparency status (Unavailable = no ATT on this OS / platform).</summary>
    public enum AttStatus { NotDetermined, Restricted, Denied, Authorized, Unavailable }

    /// <summary>UMP ConsentStatus (Google User Messaging Platform).</summary>
    public enum CmpStatus { Unknown, NotRequired, Required, Obtained }

    /// <summary>When the server wants the pre-prompt: never (None), before the first rewarded ad offer, or on the next home.</summary>
    public enum ConsentPrompt { None, AdOffer, NextHome }

    public static class ConsentWire
    {
        public static string Att(AttStatus s) => s == AttStatus.NotDetermined ? "not_determined" : s == AttStatus.Restricted ? "restricted" : s == AttStatus.Denied ? "denied" : s == AttStatus.Authorized ? "authorized" : "unavailable";
        public static AttStatus? ParseAtt(string s) => s == "not_determined" ? AttStatus.NotDetermined : s == "restricted" ? AttStatus.Restricted : s == "denied" ? AttStatus.Denied : s == "authorized" ? AttStatus.Authorized : s == "unavailable" ? AttStatus.Unavailable : (AttStatus?)null;
        public static string Cmp(CmpStatus s) => s == CmpStatus.NotRequired ? "not_required" : s == CmpStatus.Required ? "required" : s == CmpStatus.Obtained ? "obtained" : "unknown";
        public static CmpStatus? ParseCmp(string s) => s == "not_required" ? CmpStatus.NotRequired : s == "required" ? CmpStatus.Required : s == "obtained" ? CmpStatus.Obtained : s == "unknown" ? CmpStatus.Unknown : (CmpStatus?)null;
    }

    /// <summary>One switch: what the player chose, what applies, and why it does not (minor | under18 | age_unknown | att | cmp).</summary>
    public sealed class ConsentChoice
    {
        public bool Value, Effective;
        public string Locked;
        public bool IsLocked => Locked != null;
        internal static ConsentChoice Parse(JsonNode o, bool def) => o == null
            ? new ConsentChoice { Value = def, Effective = def }
            : new ConsentChoice { Value = J.Bool(o, "value", def), Effective = J.Bool(o, "effective", def), Locked = J.Str(o, "locked") };
    }

    /// <summary>
    /// What the native ad request uses (REQ-CNS-010, §21 adRequest): npa=1 → non-personalised (AdMob extras "npa" = "1"),
    /// the under-age-of-consent tag (TFUA) and the child-directed tag (TFCD).
    /// </summary>
    public sealed class AdRequestConfig
    {
        public int Npa = 1;
        public bool NonPersonalized = true, UnderAgeOfConsent, AgeKnown, TagForChildDirected;
        public Dictionary<string, string> Extras = new Dictionary<string, string> { ["npa"] = "1" };

        /// <summary>Safe default while nothing was fetched: non-personalised.</summary>
        public static AdRequestConfig NonPersonalizedDefault => new AdRequestConfig();

        internal static AdRequestConfig Parse(JsonNode o)
        {
            if (o == null) return new AdRequestConfig();
            var c = new AdRequestConfig
            {
                Npa = J.Int(o, "npa", 1), NonPersonalized = J.Bool(o, "nonPersonalized", true), UnderAgeOfConsent = J.Bool(o, "underAgeOfConsent"),
                AgeKnown = J.Bool(o, "ageKnown"), TagForChildDirected = J.Bool(o, "tagForChildDirected"), Extras = new Dictionary<string, string>(),
            };
            var ex = J.Opt(o, "extras");
            if (ex != null && ex.Kind == JsonKind.Object) foreach (var kv in ex.Props) c.Extras[kv.Key] = kv.Value.Kind == JsonKind.String ? kv.Value.AsString() : kv.Value.ToString();
            // never personalise by accident: either flag set means non-personalised
            if (c.NonPersonalized || c.Npa != 0) { c.NonPersonalized = true; c.Npa = 1; c.Extras["npa"] = "1"; }
            return c;
        }
    }

    /// <summary>GET /v1/privacy/choices (and the `privacyChoices` block of GET /v1/player / the bootstrap).</summary>
    public sealed class ConsentState
    {
        public string PolicyVersion, DecidedVersion;
        public long? DecidedAt, UpdatedAt;
        public int Rev;
        public bool Required, Minor;
        public ConsentPrompt Prompt;
        public ConsentChoice PersonalizedAds = new ConsentChoice();
        public ConsentChoice Analytics = new ConsentChoice { Value = true, Effective = true };
        public string Os;
        public AttStatus? Att;
        public bool? GdprApplies;
        public CmpStatus? Cmp;
        public AdRequestConfig AdRequest = new AdRequestConfig();
        /// <summary>Optional analytics events may be sent (the server drops them otherwise).</summary>
        public bool OptionalAnalytics = true;

        /// <summary>
        /// REQ-CNS-013: whether a client event may be queued. Every client event is optional analytics; the essential
        /// records (purchases, consent…) are written by the server itself.
        /// </summary>
        public bool AllowsClientEvent(string name) => OptionalAnalytics;

        /// <summary>
        /// R20 integration (§58.10 × §60.6): the diagnostics consent of the error reporter is the <b>analytics</b> choice — a
        /// report may carry the player id only while analytics is effective (a minor without a guardian's consent, an EEA
        /// default or a withdrawn choice → anonymous reports). The reports themselves are always sent (no personal data).
        /// The server applies the same rule (POST /v1/client-errors), so an old app cannot attach the id either.
        /// </summary>
        public bool AllowsDiagnostics => Analytics.Effective && OptionalAnalytics;

        public static ConsentState Parse(JsonNode o)
        {
            var s = new ConsentState();
            if (o == null || o.Kind != JsonKind.Object) return s;
            s.PolicyVersion = J.Str(o, "policyVersion");
            s.DecidedVersion = J.Str(o, "decidedVersion");
            s.DecidedAt = J.LongN(o, "decidedAt");
            s.UpdatedAt = J.LongN(o, "updatedAt");
            s.Rev = J.Int(o, "rev");
            s.Required = J.Bool(o, "required");
            s.Minor = J.Bool(o, "minor");
            var p = J.Str(o, "prompt");
            s.Prompt = p == "ad_offer" ? ConsentPrompt.AdOffer : p == "next_home" ? ConsentPrompt.NextHome : ConsentPrompt.None;
            s.PersonalizedAds = ConsentChoice.Parse(J.Opt(o, "personalizedAds"), false);
            s.Analytics = ConsentChoice.Parse(J.Opt(o, "analytics"), true);
            var pl = J.Opt(o, "platform");
            if (pl != null)
            {
                s.Os = J.Str(pl, "os");
                s.Att = ConsentWire.ParseAtt(J.Str(pl, "att"));
                var g = J.Opt(pl, "gdprApplies");
                s.GdprApplies = g != null && g.Kind == JsonKind.Bool ? g.AsBool() : (bool?)null;
                s.Cmp = ConsentWire.ParseCmp(J.Str(pl, "cmp"));
            }
            s.AdRequest = AdRequestConfig.Parse(J.Opt(o, "adRequest"));
            var k = J.Opt(o, "kpi");
            s.OptionalAnalytics = k != null ? J.Bool(k, "optional", s.Analytics.Effective) : s.Analytics.Effective;
            return s;
        }
    }

    /// <summary>What the UMP consent gathering returned.</summary>
    public sealed class CmpResult
    {
        /// <summary>The EEA / UK rules apply (UMP: consent required or obtained). Null = unknown.</summary>
        public bool? GdprApplies;
        public CmpStatus Status = CmpStatus.Unknown;
        /// <summary>The player may change the choice later through UMP's privacy options form (show the settings row).</summary>
        public bool PrivacyOptionsRequired;
        /// <summary>UMP says ads may be requested (canRequestAds).</summary>
        public bool CanRequestAds = true;
    }

    /// <summary>
    /// The native consent hooks (Codex implements them in Assets/Muchi/Integration; docs/handoff-codex-round20-consent.md).
    /// iOS: ATTrackingManager. Android / EEA: Google UMP (ConsentInformation / ConsentForm). Every call must be safe to
    /// make on a platform without the feature (return Unavailable / NotRequired) and must never throw for a refusal.
    /// </summary>
    public interface IConsentPlatform
    {
        /// <summary>"ios" | "android" | "other".</summary>
        string Os { get; }
        /// <summary>The current ATT status without asking (Unavailable off iOS / below iOS 14).</summary>
        AttStatus AttStatus { get; }
        /// <summary>Shows the system ATT dialog when NotDetermined (the OS shows it at most once) and returns the result.</summary>
        Task<AttStatus> RequestAttAsync(CancellationToken ct);
        /// <summary>UMP: requestConsentInfoUpdate + loadAndShowConsentFormIfRequired (tagged for under-age users when asked).</summary>
        Task<CmpResult> GatherCmpAsync(bool underAgeOfConsent, CancellationToken ct);
        /// <summary>UMP's privacy options form is required (show 「広告の同意を見直す」 in the settings).</summary>
        bool PrivacyOptionsRequired { get; }
        /// <summary>UMP showPrivacyOptionsForm; returns the new status.</summary>
        Task<CmpResult> ShowPrivacyOptionsAsync(CancellationToken ct);
        /// <summary>Opens this app's page in the OS settings (ATT was denied: only the OS can change it).</summary>
        void OpenAppSettings();
    }

    /// <summary>For editor / tests / platforms without consent SDKs: no ATT, no CMP.</summary>
    public sealed class NoConsentPlatform : IConsentPlatform
    {
        public string Os { get; set; } = "other";
        public AttStatus AttStatus => AttStatus.Unavailable;
        public Task<AttStatus> RequestAttAsync(CancellationToken ct) => Task.FromResult(AttStatus.Unavailable);
        public Task<CmpResult> GatherCmpAsync(bool underAgeOfConsent, CancellationToken ct) => Task.FromResult(new CmpResult { GdprApplies = false, Status = CmpStatus.NotRequired });
        public bool PrivacyOptionsRequired => false;
        public Task<CmpResult> ShowPrivacyOptionsAsync(CancellationToken ct) => Task.FromResult(new CmpResult { GdprApplies = false, Status = CmpStatus.NotRequired });
        public void OpenAppSettings() { }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-CNS-002: the choices, what applies and when to show the pre-prompt (read-only).</summary>
        public Task<ConsentState> GetPrivacyChoicesAsync(CancellationToken ct = default)
            => Call("GET", "/v1/privacy/choices", null, true, null, true, ConsentState.Parse, ct);

        /// <summary>
        /// REQ-CNS-005: records a decision under <paramref name="privacyVersion"/> (the current one, else
        /// ConflictException CONSENT_VERSION_MISMATCH → refetch). Null = keep the value in effect. source: prompt | settings.
        /// Idempotent by content (retries are safe).
        /// </summary>
        public Task<ConsentState> SetPrivacyChoicesAsync(string privacyVersion, string source, bool? personalizedAds, bool? analytics, CancellationToken ct = default)
        {
            if (source != "prompt" && source != "settings") throw new ArgumentException("source must be prompt or settings");
            var b = JsonNode.Obj().Set("privacyVersion", privacyVersion ?? "").Set("source", source);
            if (personalizedAds.HasValue) b.Set("personalizedAds", personalizedAds.Value);
            if (analytics.HasValue) b.Set("analytics", analytics.Value);
            return Call("PUT", "/v1/privacy/choices", b, true, null, true, ConsentState.Parse, ct);
        }

        /// <summary>REQ-CNS-009: what the OS / UMP decided. Null fields are not sent (the server keeps what it has).</summary>
        public Task<ConsentState> ReportPrivacyPlatformAsync(string os, AttStatus? att, bool? gdprApplies, CmpStatus? cmp, CancellationToken ct = default)
        {
            string o = os == "ios" || os == "android" ? os : "other";
            var b = JsonNode.Obj().Set("os", o);
            if (att.HasValue) b.Set("att", ConsentWire.Att(att.Value));
            if (gdprApplies.HasValue) b.Set("gdprApplies", gdprApplies.Value);
            if (cmp.HasValue) b.Set("cmp", ConsentWire.Cmp(cmp.Value));
            return Call("PUT", "/v1/privacy/platform", b, true, null, true, ConsentState.Parse, ct);
        }

        /// <summary>REQ-CNS-007: the pre-prompt was shown (once per policy version).</summary>
        public Task<ConsentState> NotePrivacyPromptShownAsync(string privacyVersion, CancellationToken ct = default)
            => Call("POST", "/v1/privacy/prompt-shown", JsonNode.Obj().Set("privacyVersion", privacyVersion ?? ""), true, null, true, ConsentState.Parse, ct);
    }
}
