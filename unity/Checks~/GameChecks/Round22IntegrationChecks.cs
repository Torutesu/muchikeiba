// Round 22 integration (contracts/protocol.md §54 × §66 / §67 / §68 / §69): what a change of account (SESSION_REPLACED or a
// redeemed 引き継ぎコード) drops on this device from the four Round 22 features — the §67 play-time clock and a sheet that was up,
// the old account's own limits view; the §68 outcome sheet waiting for the old account and its offline copy; the §66 career
// map and a keyed race start waiting to be re-sent; the §69 survey row / sheet — and that the one prompt gate starts over.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class Round22IntegrationChecks
{
    public static void Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var kv = new MemoryKeyValueStore();
        var off = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, null, null, kv, ruleset);
        long now = 1_790_000_000_000L;

        // §67: the old account's play time on this device
        var limits = new SelfLimitsModel(off, null, () => now);
        limits.Clock.Foreground(now);
        now += 50 * 60_000L;
        limits.Clock.Tick(now);
        check(limits.Clock.SessionMinutes == 50 && limits.Clock.DayMinutes == 50, "account: (the old account played 50 minutes)");

        // §68: a passed series whose sheet waits for the old account (its offline copy is on the device)
        kv.Set(PromotionModel.KeyCache, "1|2026-11:C:1|passed||3|top,top,skip");
        var promo = new PromotionModel(off);
        promo.RefreshAsync().GetAwaiter().GetResult();
        check(promo.View?.Series?.Id == "2026-11:C:1", "account: (the old account's promotion copy)");

        // §66: a keyed career start waiting to be re-sent
        kv.Set(CareerModel.KeyPendingStart, "car_c1_r1:h1:0|c:career-old");
        var career = new CareerModel(off);

        var prompts = new SessionPrompts();
        check(prompts.TryClaim(SessionPrompts.PromotionOutcome), "account: (the outcome sheet took the old account's session)");
        var reset = new AccountChangeReset { SelfLimits = limits, Promotion = promo, Career = career, Prompts = prompts };
        var maint = new MaintenanceModel(null, "ios");
        reset.Watch(maint);
        maint.OnSessionReplaced();

        check(limits.Clock.SessionMinutes == 0 && limits.Clock.DayMinutes == 0 && !limits.SheetVisible && limits.View == null,
            "account: §67 the play-time clock starts afresh and the old account's limits view goes");
        check(promo.View == null && !promo.OutcomeSheetVisible && promo.OutcomeInline == null && promo.ResultBanner == null && string.IsNullOrEmpty(kv.Get(PromotionModel.KeyCache)),
            "account: §68 the old account's outcome sheet and offline copy go (never shown to the new account)");
        check(string.IsNullOrEmpty(kv.Get(CareerModel.KeyPendingStart)) && career.Phase == CareerPhase.Map && career.View == null && career.Session == null,
            "account: §66 the career map and a keyed start waiting for the old account go");
        check(prompts.Claimed == null, "account: the one prompt gate starts over");
        promo.RefreshAsync().GetAwaiter().GetResult();
        check(promo.View == null, "account: offline, the new account sees no old promotion copy");
    }
}
