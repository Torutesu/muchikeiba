using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-AD-001..012 (contracts/protocol.md §21, docs/handoff-codex-round9.md §8): opt-in rewarded video ads, the game
    // layer. Pure C# (no UnityEngine): the native SDK (AdMob) lives behind IAdProvider, implemented by Codex in
    // Assets/Muchi/Integration. The model decides WHERE an offer card may appear, runs one view, and reports the result.
    // It never grants anything: the reward arrives on the server through the ad network's SSV callback and the model
    // only polls the session.

    /// <summary>Where the app is when it asks for an offer card.</summary>
    public enum AdContext
    {
        /// <summary>Home screen (placement surface "home").</summary>
        Home,
        /// <summary>A ranked result screen after a top-3 finish (surface "result"; never after a 4th or worse, 06 §5.1).</summary>
        Result,
        /// <summary>Time attack screen when today's attempts are used up (surface "time_attack").</summary>
        TimeAttack,
        /// <summary>Shop (surface "shop").</summary>
        Shop,
        /// <summary>Tutorial / first session (FTUE): never.</summary>
        Tutorial,
        /// <summary>Matching or in a race (also spectating / replays): never.</summary>
        Race,
        /// <summary>Any other screen: no card.</summary>
        Other,
    }

    /// <summary>What the native SDK is asked to show (one rewarded ad with server-side verification options).</summary>
    public sealed class AdShowRequest
    {
        /// <summary>Key of the ad unit in the app's build settings (the id itself is never in the repository).</summary>
        public string AdUnitKey;
        /// <summary>ServerSideVerificationOptions.customData (= the server's session id).</summary>
        public string CustomData;
        /// <summary>ServerSideVerificationOptions.userId (= the player id).</summary>
        public string UserId;
        /// <summary>Request non-personalised ads (npa=1) — true unless the player is a registered adult.</summary>
        public bool NonPersonalized = true;
        /// <summary>Tag the request for users under the age of consent.</summary>
        public bool UnderAgeOfConsent;
    }

    /// <summary>How the native ad ended. Shown = the SDK reported the reward was earned (the server still decides).</summary>
    public enum AdShowOutcome { Shown, ClosedEarly, NoFill, Failed }

    /// <summary>The native rewarded-ad SDK (AdMob on iOS/Android). Implemented outside the game layer (Codex).</summary>
    public interface IAdProvider
    {
        /// <summary>A rewarded ad for this unit is loaded (or can be shown without a visible wait). Cards are only offered when true.</summary>
        bool IsReady(string adUnitKey);
        /// <summary>Starts loading an ad for this unit in the background (call when an offer card may soon be shown).</summary>
        void Preload(string adUnitKey, bool nonPersonalized, bool underAgeOfConsent);
        /// <summary>Shows the ad full screen with the SSV options and completes when it is closed.</summary>
        Task<AdShowOutcome> ShowAsync(AdShowRequest request, CancellationToken ct);
    }

    /// <summary>
    /// Consent hook (REQ-AD-009): ATT on iOS (asked at most once, 06 §2.3: from the 2nd launch on day 2+, never in the FTUE);
    /// UMP/GDPR is not needed for the Japan-only launch but the hook stays so a later region can plug it in. Returns
    /// whether personalised ads may be requested (false = non-personalised only; ads still work).
    /// </summary>
    public interface IAdConsent
    {
        Task<bool> PersonalizedAllowedAsync(CancellationToken ct);
    }

    /// <summary>One offer card on screen. All texts come from the server (fixed amounts, never 「倍」).</summary>
    public sealed class AdOfferCard
    {
        public string PlacementId, Surface, Title, RewardLabel, AdUnitKey;
        /// <summary>"今日あと1回" style remaining line.</summary>
        public string LeftLabel;
        public string ButtonLabel = "動画を見る";
        /// <summary>Small print under the card.</summary>
        public string Footnote = "自分で選んだ時だけ再生します。最後まで見ると受け取れます。";
        public int Left;
    }

    public enum AdWatchStatus { Rewarded, NotCompleted, Rejected, Pending, Unavailable, LimitReached, NotAllowed }

    public sealed class AdWatchResult
    {
        public AdWatchStatus Status;
        public string Message;
        public string RewardLabel;
        public Wallet Wallet;
        public string SessionId;
    }

    /// <summary>
    /// Rewarded-ad flow for one player. Rules (REQ-AD-001/003):
    ///  - cards only when the server says the player is eligible (FTUE done, not the install day, age, 30 days after a
    ///    payment unless opted in, not opted out) and the placement has views left today;
    ///  - never in the tutorial, matching, a race, or a result screen after 4th or worse; never interstitial: a view only
    ///    starts from <see cref="WatchAsync"/>, which the screen calls when the player taps the card;
    ///  - one view at a time; offline → no card;
    ///  - the reward is only what the server granted (SSV): the model polls the session after the ad closed.
    /// KPI: ad_offer_view once per card and screen visit (<see cref="NoteOfferShown"/>), ad_start with the SDK outcome.
    /// </summary>
    public sealed class RewardedAdModel
    {
        public const int PollAttempts = 8;
        public const int PollIntervalMs = 1000;

        private readonly ApiClient _api;
        private readonly IAdProvider _ads;
        private readonly IAdConsent _consent;
        private readonly AnalyticsClient _analytics;
        private readonly IDelay _delay;
        private readonly Func<long> _clock;
        private readonly HashSet<string> _seen = new HashSet<string>();
        private int _busy;

        public AdsView View { get; private set; }
        public bool Busy => _busy != 0;

        public RewardedAdModel(ApiClient api, IAdProvider ads, AnalyticsClient analytics = null, IAdConsent consent = null, IDelay delay = null, Func<long> clock = null)
        {
            _api = api ?? throw new ArgumentNullException(nameof(api));
            _ads = ads;
            _analytics = analytics;
            _consent = consent;
            _delay = delay ?? TaskDelay.Instance;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        /// <summary>Surface of a context, or null when no ad may ever be offered there.</summary>
        public static string SurfaceOf(AdContext c)
        {
            switch (c)
            {
                case AdContext.Home: return "home";
                case AdContext.Result: return "result";
                case AdContext.TimeAttack: return "time_attack";
                case AdContext.Shop: return "shop";
                default: return null;
            }
        }

        /// <summary>Fetches the offers (call when entering home / result / time attack). Starts preloading the ads that may be offered.</summary>
        public async Task<AdsView> RefreshAsync(CancellationToken ct = default)
        {
            View = await _api.GetAdsAsync(ct);
            if (_ads != null && View.Eligible)
                foreach (var p in View.Placements)
                    if (p.Available) _ads.Preload(p.AdUnitKey, View.AdRequest.NonPersonalized, View.AdRequest.UnderAgeOfConsent);
            return View;
        }

        /// <summary>Call when a screen is entered: the next card shown there counts as a new ad_offer_view.</summary>
        public void OnScreenEntered() => _seen.Clear();

        /// <summary>
        /// The card to show in <paramref name="context"/>, or null. <paramref name="lastPlace"/> = the finishing place on a
        /// result screen (cards only after a top-3 finish). <paramref name="online"/>: offline never shows a card.
        /// </summary>
        public AdOfferCard OfferFor(AdContext context, bool online = true, int? lastPlace = null)
        {
            string surface = SurfaceOf(context);
            if (surface == null || !online || _ads == null || Busy || View == null || !View.Eligible) return null;
            if (context == AdContext.Result && (lastPlace == null || lastPlace.Value > 3)) return null;
            var p = View.ForSurface(surface);
            if (p == null || !_ads.IsReady(p.AdUnitKey)) return null;
            return new AdOfferCard
            {
                PlacementId = p.Id, Surface = p.Surface, Title = p.Title, RewardLabel = p.RewardLabel, AdUnitKey = p.AdUnitKey, Left = p.Left,
                LeftLabel = "今日あと" + p.Left + "回",
            };
        }

        /// <summary>Record that the card is on screen (ad_offer_view once per card per screen visit).</summary>
        public void NoteOfferShown(AdOfferCard card)
        {
            if (card == null || !_seen.Add(card.PlacementId)) return;
            _analytics?.Track(AnalyticsEvent.AdOfferView(_clock(), card.PlacementId, card.Surface));
        }

        /// <summary>
        /// The player tapped the card: open a session, show the ad, then wait for the server's verdict. Never throws for
        /// ad / network problems — the result says what to show.
        /// </summary>
        public async Task<AdWatchResult> WatchAsync(AdOfferCard card, AdContext context, CancellationToken ct = default)
        {
            if (card == null) throw new ArgumentNullException(nameof(card));
            if (SurfaceOf(context) != card.Surface) return new AdWatchResult { Status = AdWatchStatus.NotAllowed, Message = "ここでは動画を再生できません。" };
            if (Interlocked.CompareExchange(ref _busy, 1, 0) != 0) return new AdWatchResult { Status = AdWatchStatus.NotAllowed, Message = "再生中です。" };
            try
            {
                AdStart start;
                try { start = await _api.StartAdAsync(card.PlacementId, null, ct); }
                catch (ConflictException e) when (e.Code == ApiErrorCode.AdLimitReached)
                {
                    await TryRefresh(ct);
                    return new AdWatchResult { Status = AdWatchStatus.LimitReached, Message = "今日の分は受け取りました。また明日どうぞ。" };
                }
                catch (ApiException)
                {
                    await TryRefresh(ct);
                    return new AdWatchResult { Status = AdWatchStatus.Unavailable, Message = "今は動画を用意できません。時間をおいてお試しください。" };
                }

                bool personalized = false;
                if (_consent != null && !start.AdRequest.NonPersonalized)
                {
                    try { personalized = await _consent.PersonalizedAllowedAsync(ct); } catch (Exception) { personalized = false; }
                }
                var req = new AdShowRequest
                {
                    AdUnitKey = start.AdUnitKey, CustomData = start.CustomData, UserId = start.UserId,
                    NonPersonalized = start.AdRequest.NonPersonalized || !personalized, UnderAgeOfConsent = start.AdRequest.UnderAgeOfConsent,
                };
                AdShowOutcome outcome;
                try { outcome = await _ads.ShowAsync(req, ct); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception) { outcome = AdShowOutcome.Failed; }
                _analytics?.Track(AnalyticsEvent.AdStart(_clock(), card.PlacementId, card.Surface, OutcomeWire(outcome)));
                if (outcome == AdShowOutcome.NoFill || outcome == AdShowOutcome.Failed)
                    return new AdWatchResult { Status = AdWatchStatus.Unavailable, SessionId = start.SessionId, Message = "今は動画を用意できません。時間をおいてお試しください。" };
                if (outcome == AdShowOutcome.ClosedEarly)
                    return new AdWatchResult { Status = AdWatchStatus.NotCompleted, SessionId = start.SessionId, Message = "最後まで見ると受け取れます。" };

                // Shown: the reward is what the server granted from the SSV callback
                for (int i = 0; i < PollAttempts; i++)
                {
                    if (i > 0) await _delay.Delay(PollIntervalMs, ct);
                    AdSessionStatus st;
                    try { st = await _api.GetAdSessionAsync(start.SessionId, ct); }
                    catch (ApiException) { continue; }
                    if (st.Rewarded)
                    {
                        await TryRefresh(ct);
                        return new AdWatchResult { Status = AdWatchStatus.Rewarded, SessionId = st.SessionId, RewardLabel = st.RewardLabel, Wallet = st.Wallet, Message = "受け取りました：" + st.RewardLabel };
                    }
                    if (st.Final)
                    {
                        await TryRefresh(ct);
                        return new AdWatchResult { Status = AdWatchStatus.Rejected, SessionId = st.SessionId, Message = "今回は受け取れませんでした。" };
                    }
                }
                return new AdWatchResult { Status = AdWatchStatus.Pending, SessionId = start.SessionId, Message = "確認に時間がかかっています。届きしだい反映されます。" };
            }
            finally
            {
                Interlocked.Exchange(ref _busy, 0);
            }
        }

        /// <summary>Settings → 広告: Auto (default) / On (show even after paying) / Off (never).</summary>
        public async Task<AdsView> SetPreferenceAsync(AdPref pref, CancellationToken ct = default)
        {
            View = await _api.SetAdPreferenceAsync(pref, ct);
            return View;
        }

        /// <summary>The settings line for the current preference / reason.</summary>
        public static string PreferenceLabel(AdsView v)
        {
            if (v == null) return "";
            if (v.Pref == "off") return "動画広告：表示しない";
            if (v.Pref == "on") return "動画広告：表示する";
            return v.Reason == "payer_quiet" ? "動画広告：自動（ご購入から30日は表示しません）" : "動画広告：自動";
        }

        private static string OutcomeWire(AdShowOutcome o)
            => o == AdShowOutcome.Shown ? "shown" : o == AdShowOutcome.ClosedEarly ? "closed_early" : o == AdShowOutcome.NoFill ? "no_fill" : "failed";

        private async Task TryRefresh(CancellationToken ct)
        {
            try { View = await _api.GetAdsAsync(ct); } catch (ApiException) { }
        }
    }
}
