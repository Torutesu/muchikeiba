using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // 広告・分析の同意管理 (REQ-CNS-001..020, contracts/protocol.md §58, docs/handoff-codex-round20-consent.md).
    // Pure C# (no UnityEngine). The native ATT / UMP calls sit behind Muchi.Client.IConsentPlatform (Codex). This model
    //  - decides when the pre-prompt sheet appears (the server names the moment: before the first rewarded-ad offer, or
    //    on the next home after a policy update; never in the tutorial / FTUE, never offline, once per policy version);
    //  - runs the sheet: 「続ける」 → (iOS) the system ATT dialog when not yet asked → (EEA) the UMP form → saves the choices;
    //    「あとで」 saves nothing and never shows ATT (the OS dialog can only be shown once — keep it for a yes);
    //  - builds the settings rows (personalised ads, analytics, policy version, the UMP review form) with the reason a switch
    //    does not apply (age, ATT, EEA consent);
    //  - is the IAdConsent of RewardedAdModel and the analytics gate (AnalyticsClient.Gate).
    // Refusing never changes a reward: the copy says so, and the server never uses these choices for rewards or caps.

    /// <summary>Where the app is when it asks whether to show the pre-prompt.</summary>
    public enum ConsentMoment { BeforeAdOffer, Home, Tutorial, Race, Other }

    /// <summary>The pre-prompt sheet (texts in Japanese; screens show Loc.T).</summary>
    public sealed class ConsentPrePrompt
    {
        public string Kicker = "PRIVACY";
        public string Title = ConsentModel.TextPromptTitle;
        public List<string> Lines = new List<string>();
        public string Continue = ConsentModel.TextContinue;
        public string Later = ConsentModel.TextLater;
        /// <summary>Initial switch values on the sheet (non-iOS; on iOS personalised ads follow the ATT answer).</summary>
        public bool PersonalizedAds, Analytics;
        public bool PersonalizedAdsLocked, AnalyticsLocked;
        /// <summary>iOS: the system dialog follows 「続ける」 (no personalised-ads switch on the sheet).</summary>
        public bool AttNext;
    }

    public enum ConsentRowAction { Toggle, OpenOsSettings, ReviewAdConsent, None }

    /// <summary>One row of Settings › Privacy › 広告と分析.</summary>
    public sealed class ConsentRow
    {
        public string Key, Label, Note;
        public bool Value, Enabled;
        public ConsentRowAction Action;
        public string ActionLabel;
    }

    public sealed class ConsentModel : ScreenModel, IAdConsent
    {
        public const string TextSection = "広告と分析";
        public const string TextPromptTitle = "広告と分析について";
        public const string TextPromptAds = "動画広告は、見たい時だけ自分で選んで再生します。";
        public const string TextPromptPersonal = "許可すると、興味に合った広告が出やすくなります。許可しなくても、受け取れる無償コインや遊べる内容は変わりません。";
        public const string TextPromptAnalytics = "遊び方の分析（よく使う画面など）はゲームの改善に使います。購入などの記録は法律に基づき保存します。";
        public const string TextPromptAtt = "このあと端末の確認が表示されます。";
        public const string TextPromptChange = "設定 › プライバシー から、いつでも変えられます。";
        public const string TextContinue = "続ける";
        public const string TextLater = "あとで";
        public const string TextPersonalizedAds = "パーソナライズ広告";
        public const string TextAnalytics = "分析への協力";
        public const string TextReview = "広告の同意を見直す";
        public const string TextOpenSettings = "端末の設定を開く";
        public const string TextLockMinor = "年齢の設定により、オフになっています";
        public const string TextLockMinorAnalytics = "保護者の同意があるとオンにできます";
        public const string TextLockUnder18 = "18歳未満のため、オフになっています";
        public const string TextLockAgeUnknown = "年齢が未登録のため、広告はパーソナライズされません";
        public const string TextLockAtt = "端末の設定でトラッキングが許可されていません";
        public const string TextLockCmp = "広告の同意がまだのため、オフになっています";
        public const string TextAnalyticsNote = "購入などの記録は、オフでも法律に基づき保存します";
        public const string TextSaved = "保存しました";
        public const string TextOffline = "オフラインのため変更できません";
        public const string TextStale = "プライバシーポリシーが更新されました。もう一度ご確認ください";
        public const string TextPolicyPrefix = "プライバシーポリシー ";
        public const string TextPolicySuffix = "版";

        private readonly IConsentPlatform _platform;
        private int _busy;

        public ConsentModel(GameBackend backend, IConsentPlatform platform = null) : base(backend, backend?.Store)
        {
            _platform = platform ?? new NoConsentPlatform();
            State = backend?.Player?.PrivacyChoices ?? new ConsentState();
        }

        public ConsentState State { get; private set; }
        public bool Busy => _busy != 0;
        public string Os => _platform.Os;

        /// <summary>「プライバシーポリシー 2026-11-01版」.</summary>
        public string PolicyVersionText => State?.PolicyVersion == null ? null : Loc.T(TextPolicyPrefix) + State.PolicyVersion + Loc.T(TextPolicySuffix);

        /// <summary>GET /v1/privacy/choices, then reports an ATT change made in the OS settings meanwhile.</summary>
        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Online = false; return Offline(TextOffline); }
            try
            {
                State = await B.Api.GetPrivacyChoicesAsync(ct);
                Online = true;
                await SyncPlatformAsync(ct);
                return ActionResult.Success();
            }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>Call on app resume: the player may have changed ATT in the OS settings.</summary>
        public async Task SyncPlatformAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return;
            var att = _platform.AttStatus;
            bool ios = _platform.Os == "ios";
            if (State.Os == _platform.Os && (!ios || State.Att == att)) return;
            try { State = await B.Api.ReportPrivacyPlatformAsync(_platform.Os, ios ? att : (AttStatus?)null, null, null, ct); } catch (ApiException) { }
        }

        /// <summary>
        /// REQ-CNS-007: show the sheet now? Only when the server names this moment (ad_offer → right before the first offer
        /// card; next_home → on the home), online, and never in the tutorial, a race or matching.
        /// </summary>
        public bool ShouldShowPrePrompt(ConsentMoment moment, bool online = true)
        {
            if (!online || !ServerAvailable || Busy || State == null || !State.Required) return false;
            if (Prompts != null && !Prompts.CanShow(SessionPromptKind.Consent)) return false; // R20 integration: one prompt per session
            if (moment == ConsentMoment.BeforeAdOffer) return State.Prompt == ConsentPrompt.AdOffer || State.Prompt == ConsentPrompt.NextHome;
            if (moment == ConsentMoment.Home) return State.Prompt == ConsentPrompt.NextHome;
            return false;
        }

        /// <summary>R20 integration: the session's one-prompt gate (shared with LocalNotificationModel and ReviewPromptModel).</summary>
        public SessionPromptGate Prompts { get; set; }
        /// <summary>R20 integration (§58.10): the error reporter's consent = the analytics choice (true before the first view).</summary>
        public bool AllowsDiagnostics => State?.AllowsDiagnostics ?? true;

        /// <summary>The sheet's content; building it means the sheet is on screen (it claims the session's prompt).</summary>
        public ConsentPrePrompt BuildPrePrompt()
        {
            Prompts?.Claim(SessionPromptKind.Consent);
            bool ios = _platform.Os == "ios";
            var p = new ConsentPrePrompt
            {
                PersonalizedAds = State.PersonalizedAds.Value && !State.PersonalizedAds.IsLocked,
                Analytics = State.Analytics.Value,
                PersonalizedAdsLocked = State.PersonalizedAds.Locked == "minor" || State.PersonalizedAds.Locked == "under18",
                AnalyticsLocked = State.Analytics.IsLocked,
                AttNext = ios && _platform.AttStatus == AttStatus.NotDetermined && !State.Minor,
            };
            p.Lines.Add(TextPromptAds);
            p.Lines.Add(TextPromptPersonal);
            p.Lines.Add(TextPromptAnalytics);
            if (p.AttNext) p.Lines.Add(TextPromptAtt);
            p.Lines.Add(TextPromptChange);
            return p;
        }

        /// <summary>
        /// 「続ける」: records that the sheet was shown, asks ATT (iOS, not asked yet, wants personalised ads), gathers UMP where it
        /// applies, then saves the choices. On iOS <paramref name="personalizedAds"/> is the ATT answer.
        /// </summary>
        public async Task<ActionResult> AcceptAsync(bool personalizedAds, bool analytics, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            if (Interlocked.CompareExchange(ref _busy, 1, 0) != 0) return ActionResult.Error(null);
            try
            {
                var version = State.PolicyVersion;
                State = await B.Api.NotePrivacyPromptShownAsync(version, ct);
                bool ios = _platform.Os == "ios";
                AttStatus? att = null;
                if (ios)
                {
                    att = _platform.AttStatus;
                    if (att == AttStatus.NotDetermined && !State.Minor) att = await SafeAtt(ct);
                    personalizedAds = att == AttStatus.Authorized;
                }
                CmpResult cmp = null;
                try { cmp = await _platform.GatherCmpAsync(State.AdRequest.UnderAgeOfConsent, ct); } catch (Exception) { cmp = null; }
                State = await B.Api.ReportPrivacyPlatformAsync(_platform.Os, att, cmp?.GdprApplies, cmp?.Status, ct);
                bool? ads = State.Minor || State.PersonalizedAds.Locked == "under18" ? (bool?)null : personalizedAds;
                bool? an = State.Analytics.IsLocked ? (bool?)null : analytics;
                State = await B.Api.SetPrivacyChoicesAsync(version, "prompt", ads, an, ct);
                return ActionResult.Success(TextSaved);
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.ConsentVersionMismatch) { await TryReload(ct); return ActionResult.Error(TextStale); }
            catch (ApiException e) { return Fail(e); }
            finally { Interlocked.Exchange(ref _busy, 0); }
        }

        /// <summary>「あとで」: the sheet was seen (not again this version). Nothing is decided, ATT is not shown.</summary>
        public async Task<ActionResult> LaterAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            try { State = await B.Api.NotePrivacyPromptShownAsync(State.PolicyVersion, ct); return ActionResult.Success(); }
            catch (ConflictException e) when (e.Code == ApiErrorCode.ConsentVersionMismatch) { await TryReload(ct); return ActionResult.Error(TextStale); }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>Settings › Privacy › 広告と分析.</summary>
        public List<ConsentRow> Rows()
        {
            var rows = new List<ConsentRow>();
            var ads = State.PersonalizedAds;
            var adsRow = new ConsentRow { Key = "personalized_ads", Label = TextPersonalizedAds, Value = ads.Effective, Enabled = ServerAvailable, Action = ConsentRowAction.Toggle };
            switch (ads.Locked)
            {
                case "minor": adsRow.Note = TextLockMinor; adsRow.Enabled = false; adsRow.Action = ConsentRowAction.None; break;
                case "under18": adsRow.Note = TextLockUnder18; adsRow.Enabled = false; adsRow.Action = ConsentRowAction.None; break;
                case "age_unknown": adsRow.Note = TextLockAgeUnknown; adsRow.Value = ads.Value; break;
                case "att":
                    adsRow.Note = TextLockAtt;
                    if (_platform.AttStatus == AttStatus.Denied || _platform.AttStatus == AttStatus.Restricted) { adsRow.Action = ConsentRowAction.OpenOsSettings; adsRow.ActionLabel = TextOpenSettings; adsRow.Value = false; }
                    else adsRow.Value = ads.Value;
                    break;
                case "cmp": adsRow.Note = TextLockCmp; adsRow.Action = ConsentRowAction.ReviewAdConsent; adsRow.ActionLabel = TextReview; adsRow.Value = ads.Value; break;
            }
            rows.Add(adsRow);
            var an = State.Analytics;
            rows.Add(new ConsentRow
            {
                Key = "analytics", Label = TextAnalytics, Value = an.Effective, Enabled = ServerAvailable && !an.IsLocked,
                Action = an.IsLocked ? ConsentRowAction.None : ConsentRowAction.Toggle, Note = an.Locked == "minor" ? TextLockMinorAnalytics : TextAnalyticsNote,
            });
            if (_platform.PrivacyOptionsRequired || State.GdprApplies == true)
                rows.Add(new ConsentRow { Key = "review", Label = TextReview, Enabled = ServerAvailable, Action = ConsentRowAction.ReviewAdConsent, ActionLabel = TextReview });
            foreach (var r in rows) { r.Label = Loc.T(r.Label); r.Note = Loc.T(r.Note); r.ActionLabel = Loc.T(r.ActionLabel); }
            return rows;
        }

        /// <summary>Settings switch: personalised ads. iOS asks ATT first when not asked yet; a denied ATT opens the OS settings.</summary>
        public async Task<ActionResult> SetPersonalizedAdsAsync(bool on, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            if (Interlocked.CompareExchange(ref _busy, 1, 0) != 0) return ActionResult.Error(null);
            try
            {
                if (on && _platform.Os == "ios")
                {
                    var att = _platform.AttStatus;
                    if (att == AttStatus.Denied || att == AttStatus.Restricted) { _platform.OpenAppSettings(); return ActionResult.Error(TextLockAtt); }
                    if (att == AttStatus.NotDetermined) { att = await SafeAtt(ct); State = await B.Api.ReportPrivacyPlatformAsync("ios", att, null, null, ct); }
                    if (att != AttStatus.Authorized) return ActionResult.Error(TextLockAtt);
                }
                State = await B.Api.SetPrivacyChoicesAsync(State.PolicyVersion, "settings", on, null, ct);
                return ActionResult.Success(TextSaved);
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.ConsentVersionMismatch) { await TryReload(ct); return ActionResult.Error(TextStale); }
            catch (ApiException e) { return Fail(e); }
            finally { Interlocked.Exchange(ref _busy, 0); }
        }

        /// <summary>Settings switch: analytics.</summary>
        public async Task<ActionResult> SetAnalyticsAsync(bool on, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            try { State = await B.Api.SetPrivacyChoicesAsync(State.PolicyVersion, "settings", null, on, ct); return ActionResult.Success(TextSaved); }
            catch (ConflictException e) when (e.Code == ApiErrorCode.ConsentVersionMismatch) { await TryReload(ct); return ActionResult.Error(TextStale); }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>「広告の同意を見直す」: UMP's privacy options form, then the new status to the server.</summary>
        public async Task<ActionResult> ReviewAdConsentAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextOffline);
            CmpResult r;
            try { r = await _platform.ShowPrivacyOptionsAsync(ct); } catch (Exception) { return ActionResult.Error(null); }
            try { State = await B.Api.ReportPrivacyPlatformAsync(_platform.Os, null, r?.GdprApplies, r?.Status, ct); return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>IAdConsent (RewardedAdModel): personalised ads only when they apply now (server-side effective value).</summary>
        public Task<bool> PersonalizedAllowedAsync(CancellationToken ct)
            => Task.FromResult(State != null && State.PersonalizedAds.Effective && !State.AdRequest.NonPersonalized && (_platform.Os != "ios" || _platform.AttStatus == AttStatus.Authorized));

        /// <summary>The ad request the native SDK should use now (non-personalised unless everything allows it).</summary>
        public AdRequestConfig AdRequest => State?.AdRequest ?? AdRequestConfig.NonPersonalizedDefault;

        /// <summary>REQ-CNS-013: wires the analytics gate (optional events are dropped on the device while analytics is off).</summary>
        public void Attach(AnalyticsClient analytics)
        {
            if (analytics != null) analytics.Gate = name => State == null || State.AllowsClientEvent(name);
        }

        private async Task<AttStatus> SafeAtt(CancellationToken ct)
        {
            try { return await _platform.RequestAttAsync(ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception) { return _platform.AttStatus; }
        }

        private async Task TryReload(CancellationToken ct)
        {
            try { State = await B.Api.GetPrivacyChoicesAsync(ct); } catch (ApiException) { }
        }
    }
}
