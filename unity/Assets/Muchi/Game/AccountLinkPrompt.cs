using System;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>Where the app is when it asks whether to show the account-link prompt.</summary>
    public enum LinkPromptContext
    {
        /// <summary>The home screen (after the session's other pop-ups).</summary>
        Home,
        /// <summary>Right after a result screen was closed (never on the result screen itself, 06 §5.1).</summary>
        ResultClosed,
        /// <summary>Right after a store purchase was granted (06 §2.3: 初回購入の直後).</summary>
        PurchaseComplete,
        /// <summary>Tutorial / first-session flow (FTUE).</summary>
        Tutorial,
        /// <summary>Matching, in a race, or on its result screen.</summary>
        Race,
        /// <summary>Any other screen (shop, scout, settings …): not a moment to interrupt.</summary>
        Other,
    }

    /// <summary>Why the prompt is shown (the first condition that was met).</summary>
    public enum LinkPromptTrigger { None, Day3, FirstPurchase }

    /// <summary>What the prompt screen shows (one screen, 06 §7.3 / REQ-UXU-015).</summary>
    public sealed class AccountLinkPromptView
    {
        public LinkPromptTrigger Trigger;
        public string Title = "機種変更でも相棒を引き継げます";
        public string Body;
        /// <summary>Provider buttons in display order: "apple" (iOS first; Sign in with Apple is required next to Google) and "google".</summary>
        public string[] Providers;
        public string AppleLabel = "Appleで引き継ぎ登録";
        public string GoogleLabel = "Googleで引き継ぎ登録";
        /// <summary>Closes the prompt for good; the same buttons stay in Settings → 引き継ぎ.</summary>
        public string LaterLabel = "あとで";
        public string Footnote = "登録はあとから「その他 → 引き継ぎ」でもできます。";
    }

    /// <summary>
    /// REQ-UXS-073 account-link prompt (06 §7.3, §2.3 後回しにするもの, REQ-UXU-015): one screen, shown at most once per
    /// install, on game day 3 or right after the first purchase, whichever comes first, and only while the account is
    /// still anonymous. On game day 3 itself it comes after a closed result, not on opening home (quality pass 2: the day
    /// opens on its login bonus and goals); from day 4 home may show it. Rules:
    ///  - never during the FTUE (before the first ranked race is done) or in a race / matching / on a result screen;
    ///    only on the home screen, after closing a result, or right after a purchase;
    ///  - not offline (linking needs the network; the trigger waits), not while an account deletion is scheduled;
    ///  - once only: it counts as shown when it is displayed (an app kill while it is up does not bring it back);
    ///    「あとで」 or closing it dismisses it for good; there is no snooze — Settings keeps the entry;
    ///  - linked anywhere (this prompt or Settings) → never shown, and the `account_link` KPI is sent once per link.
    /// State lives in the device store (PlayerPrefs); a reinstall that is still anonymous may see it once more.
    /// </summary>
    public sealed class AccountLinkPrompt
    {
        public const string KeyState = "muchi.link.prompt";          // null | shown | dismissed | linked
        public const string KeyFirstPurchase = "muchi.link.firstPurchase"; // "1" once a purchase was granted on this device
        public const int TriggerDay = 3;

        private readonly IKeyValueStore _kv;

        public AccountLinkPrompt(IKeyValueStore store) { _kv = store ?? new MemoryKeyValueStore(); }

        /// <summary>§58.11 (R21 integration): the session's one prompt gate (null = no gate, e.g. in checks of this model alone).</summary>
        public SessionPrompts Prompts { get; set; }

        public string State => _kv.Get(KeyState);
        public bool Shown => State != null;
        public bool Linked => State == "linked";
        public bool PurchaseSeen => _kv.Get(KeyFirstPurchase) == "1";

        /// <summary>Call when a store purchase was granted (PurchaseResult, not a duplicate). The next PurchaseComplete check may show the prompt.</summary>
        public void NotePurchase() { if (!PurchaseSeen) _kv.Set(KeyFirstPurchase, "1"); }

        /// <summary>The FTUE is over once the partner is named, the welcome scout is done and the first ranked race ran (06 §2.3).</summary>
        public static bool FtueDone(PlayerView p) => p != null && p.PartnerHorseId != null && p.TutorialGachaUsed && p.RankedRaces >= 1;

        /// <summary>Which trigger is met now (Day3 / FirstPurchase), ignoring the context.</summary>
        public LinkPromptTrigger TriggerFor(int gameDay, bool purchased)
        {
            if (purchased || PurchaseSeen) return LinkPromptTrigger.FirstPurchase;
            if (gameDay >= TriggerDay) return LinkPromptTrigger.Day3;
            return LinkPromptTrigger.None;
        }

        /// <summary>
        /// Should the prompt be shown now? <paramref name="anonymous"/> = FirebaseAuthTokenProvider.IsAnonymous;
        /// <paramref name="gameDay"/> = UnlocksView.Day (1 = install day); <paramref name="purchased"/> = a purchase was granted
        /// (this session or before; <see cref="NotePurchase"/> remembers it).
        /// </summary>
        public bool ShouldShow(LinkPromptContext context, bool anonymous, int gameDay, bool ftueDone, bool online, bool deletionScheduled = false, bool purchased = false)
        {
            if (Shown || !anonymous || !online || deletionScheduled || !ftueDone) return false;
            if (Prompts != null && !Prompts.CanShow(SessionPrompts.AccountLink)) return false; // §58.11 (R21 integration): one prompt per session
            if (context != LinkPromptContext.Home && context != LinkPromptContext.ResultClosed && context != LinkPromptContext.PurchaseComplete) return false;
            var trigger = TriggerFor(gameDay, purchased);
            // quality pass 2 (docs/quality/first-week.md): on the trigger day itself the session opens on the login bonus and
            // the goal ladder, not on this prompt — it waits until a result is closed (the player raced: a calm, happy
            // moment). From the next day on, home may show it too (a player who did not race on day 3 still sees it once).
            if (trigger == LinkPromptTrigger.Day3 && context == LinkPromptContext.Home && gameDay <= TriggerDay) return false;
            return trigger != LinkPromptTrigger.None;
        }

        /// <summary>Convenience overload from the backend's player view.</summary>
        public bool ShouldShow(LinkPromptContext context, GameBackend backend, bool anonymous, bool purchased = false)
        {
            var p = backend?.Player;
            return ShouldShow(context, anonymous, p?.Unlocks?.Day ?? 0, FtueDone(p), backend != null && backend.Online, p?.Deletion?.Scheduled ?? false, purchased);
        }

        /// <summary>
        /// Marks the prompt as shown (call when it is put on screen) and returns what to show. <paramref name="ios"/> puts
        /// Apple first.
        /// </summary>
        public AccountLinkPromptView Show(LinkPromptTrigger trigger, bool ios = true)
        {
            Prompts?.TryClaim(SessionPrompts.AccountLink);
            if (!Shown) _kv.Set(KeyState, "shown");
            return new AccountLinkPromptView
            {
                Trigger = trigger,
                Body = trigger == LinkPromptTrigger.FirstPurchase
                    ? "お買い上げありがとうございます。購入したコインや相棒を機種変更・再インストールの後も引き継げるよう、Apple または Google のアカウントで登録しておきましょう。"
                    : "Apple または Google のアカウントで登録しておくと、機種変更や再インストールの後も、相棒と戦績をそのまま引き継げます。",
                Providers = ios ? new[] { "apple", "google" } : new[] { "google", "apple" },
            };
        }

        /// <summary>「あとで」 / closed: never shown automatically again.</summary>
        public void Dismiss() { if (!Linked) _kv.Set(KeyState, "dismissed"); }

        /// <summary>
        /// Record a link result (from this prompt or from Settings). On <see cref="LinkResult.Linked"/> returns the
        /// `account_link` KPI event to track (null otherwise, or when this link was already reported).
        /// ProviderAlreadyLinked also closes the prompt (the account is not anonymous).
        /// </summary>
        public AnalyticsEvent OnLinkResult(LinkResult result, string provider, long atMs)
        {
            if (result == LinkResult.CredentialInUse) return null; // the player decides to switch or cancel; nothing linked here
            bool wasLinked = Linked;
            _kv.Set(KeyState, "linked");
            return result == LinkResult.Linked && !wasLinked ? AnalyticsEvent.AccountLink(atMs, provider) : null;
        }

        /// <summary>Link with the token provider, record it, and track `account_link` on success.</summary>
        public async Task<LinkResult> LinkAsync(FirebaseAuthTokenProvider auth, FederatedCredential credential, AnalyticsClient analytics, Func<long> clock = null, CancellationToken ct = default)
        {
            if (auth == null) throw new ArgumentNullException(nameof(auth));
            if (credential == null) throw new ArgumentNullException(nameof(credential));
            var r = await auth.LinkAsync(credential, ct);
            var e = OnLinkResult(r, credential.Provider, (clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))());
            if (e != null) analytics?.Track(e);
            return r;
        }
    }
}
