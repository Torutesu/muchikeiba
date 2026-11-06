// Round 8 client QA (fix/r8-client-qa): regressions for bugs found in the round 8 game layer. Each check failed before
// its fix. Same routed fake server as Round8Checks (bodies shaped like the real server's answers).
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static partial class Round8Checks
{
    const string PurchaseOk = "{\"record\":{\"txId\":\"tx1\",\"productId\":\"coin_160\"},\"duplicate\":false,\"wallet\":{\"paid\":200,\"free\":295,\"total\":495,\"debt\":0}}";
    const string StarterProduct = "{\"id\":\"starter_pack\",\"kind\":\"starter\",\"name\":\"スターターパック\",\"tab\":\"recommended\",\"storeType\":\"non_consumable\",\"priceYen\":480,\"paidCoins\":300,\"once\":true,\"autoRenew\":false,\"contents\":[{\"type\":\"paid_coins\",\"qty\":300,\"label\":\"有償コイン300枚\"}],\"firstPurchaseBonus\":null,\"oneTime\":true,\"oneTimeScope\":\"account\",\"period\":null,\"noticeKeys\":[\"shop.one_time\"]}";

    static async Task QaRun(Action<bool, string> check, RulesetParams rs)
    {
        await QaDeferredAndQueuedReceipts(check, rs);
        await QaFtueOfflinePreviewStillDrawsTheScout(check, rs);
        await QaOfflineConsentToOldTerms(check, rs);
        await QaShopDeletionAndOnceOnly(check, rs);
        QaFtueKpiOnce(check, rs);
        QaStoreCopy(check);
    }

    /// <summary>03 legal guard / 06 §5.5: the old Store screen (MuchiApp coin packs) never says 「2倍」 / 2×.</summary>
    static void QaStoreCopy(Action<bool, string> check)
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "contracts", "protocol.md"))) d = d.Parent;
        if (d == null) { check(false, "repo root not found"); return; }
        string app = File.ReadAllText(Path.Combine(d.FullName, "unity", "Assets", "Muchi", "Runtime", "MuchiApp.cs"));
        string ja = File.ReadAllText(Path.Combine(d.FullName, "unity", "Assets", "Resources", "Localization", "ja.json"));
        check(!app.Contains("2× BONUS") && !ja.Contains("2倍") && ja.Contains("同じ枚数の無償コイン"), "Store coin packs: no 「2倍」 / 2× wording; the bonus is stated as free coins");
    }

    static P Shopper() => new P { ConsentRequired = false, ConsentedTerms = "2026-11-01", PartnerId = "h1", GachaUsed = true, Horses = "[" + Horse1 + "]", Unlocks = AllUnlocks };

    // ------------------------------------------------------------------ purchase receipts

    static async Task QaDeferredAndQueuedReceipts(Action<bool, string> check, RulesetParams rs)
    {
        var (s, b, kv) = Setup(Shopper(), rs);
        s.Routes["POST /v1/shop/purchase-intent"] = _ => Ok(IntentCoin);
        s.Routes["POST /v1/shop/purchase"] = _ => Ok(PurchaseOk);

        // Ask to Buy: the store says "deferred", later the approved transaction arrives through the same callback
        var pc = new PurchaseConfirmModel(b, null, () => now);
        await pc.OpenAsync("coin_160");
        pc.BeginStore();
        check(await pc.StoreFinishedAsync(StoreOutcome.Deferred) == PurchaseStage.Pending, "deferred purchase: 「確認中」");
        var approved = await pc.StoreFinishedAsync(StoreOutcome.Purchased, StorePlatform.Fake, "rcpt-deferred");
        check(approved == PurchaseStage.Completed && s.To("POST", "/v1/shop/purchase").Any(r => r.Body.Contains("rcpt-deferred")),
            "a deferred purchase approved later is granted (its receipt is sent, not ignored in the Pending stage)");

        // a transaction the store replays at launch (no sheet open) is granted too
        var idle = new PurchaseConfirmModel(b, null, () => now);
        check(await idle.StoreDeliveredAsync(StorePlatform.Fake, "coin_160", "rcpt-replayed") == PurchaseStage.Completed && s.To("POST", "/v1/shop/purchase").Any(r => r.Body.Contains("rcpt-replayed")),
            "an unfinished transaction delivered at launch is granted from any stage");

        // two paid purchases without an answer: both receipts are kept, the second never overwrites the first
        s.Routes["POST /v1/shop/purchase"] = _ => Err(503, "INTERNAL");
        var a = new PurchaseConfirmModel(b, null, () => now);
        await a.OpenAsync("coin_160"); a.BeginStore();
        await a.StoreFinishedAsync(StoreOutcome.Purchased, StorePlatform.Fake, "rcpt-A");
        var c = new PurchaseConfirmModel(b, null, () => now);
        await c.OpenAsync("coin_160"); c.BeginStore();
        await c.StoreFinishedAsync(StoreOutcome.Purchased, StorePlatform.Fake, "rcpt-B");
        s.Routes["POST /v1/shop/purchase"] = _ => Ok(PurchaseOk);
        int before = s.Count("POST", "/v1/shop/purchase");
        var relaunch = new PurchaseConfirmModel(b, null, () => now);
        await relaunch.ResumePendingAsync();
        var resent = s.To("POST", "/v1/shop/purchase").Skip(before).Select(r => r.Body).ToList();
        check(resent.Any(x => x.Contains("rcpt-A")) && resent.Any(x => x.Contains("rcpt-B")) && !relaunch.HasPendingReceipt,
            "two unsent receipts are both kept and both re-sent on the next launch (the second purchase did not overwrite the first)");

        // an expired sign-in (401) on the grant is not a refusal of the receipt: it stays for the next launch
        s.Routes["POST /v1/shop/purchase"] = _ => Err(401, "UNAUTHORIZED");
        var auth = new PurchaseConfirmModel(b, null, () => now);
        await auth.OpenAsync("coin_160"); auth.BeginStore();
        check(await auth.StoreFinishedAsync(StoreOutcome.Purchased, StorePlatform.Fake, "rcpt-401") == PurchaseStage.Pending && auth.HasPendingReceipt,
            "401 on the grant keeps the paid receipt (pending), it is not dropped");
        s.Routes["POST /v1/shop/purchase"] = _ => Err(409, "RECEIPT_INVALID");
        await new PurchaseConfirmModel(b, null, () => now).ResumePendingAsync();
        check(!auth.HasPendingReceipt, "RECEIPT_INVALID (a definite refusal) drops it");
    }

    // ------------------------------------------------------------------ FTUE

    static async Task QaFtueOfflinePreviewStillDrawsTheScout(Action<bool, string> check, RulesetParams rs)
    {
        // the whole FTUE offline, including the welcome-scout preview and home
        var kv = new MemoryKeyValueStore();
        var off = OfflineBackend(rs, kv);
        var flow = new OnboardingFlow(off, null, () => now);
        await flow.ResumeAsync();
        await flow.AcceptConsentAsync();
        Ride(flow.StartFirstRace()); Ride(flow.StartFirstRace());
        flow.FinishFirstRace(Ride(flow.StartFirstRace()));
        await flow.SubmitNameAsync("イッセン");
        await flow.DrawFirstScoutAsync();
        flow.FinishFirstScout();
        flow.EnterHome();
        check(flow.Screen == FtueStep.Done, "offline: the FTUE can finish with the scout preview");

        var player = new P();
        var s = new FakeServer();
        s.Routes["POST /v1/player/consent"] = _ => { player.ConsentRequired = false; player.ConsentedTerms = player.Terms; return Ok("{\"termsVersion\":\"2026-11-01\",\"privacyVersion\":\"2026-11-01\",\"current\":{\"termsVersion\":\"2026-11-01\",\"privacyVersion\":\"2026-11-01\"},\"required\":false}"); };
        s.Routes["POST /v1/player/partner"] = _ => { player.PartnerId = "h1"; player.Horses = "[" + Horse1 + "]"; return Ok("{\"horse\":" + Horse1 + "}"); };
        s.Routes["POST /v1/gacha/tutorial"] = _ => { player.GachaUsed = true; return Ok(Draw); };
        var (_, b, _) = Setup(player, rs, kv, s);
        var online = new OnboardingFlow(b, null, () => now);
        var screen = await online.ResumeAsync();
        check(screen == FtueStep.FirstScout, "back online after an offline preview: the welcome scout screen comes back (the free 10-pull was never drawn)");
        check((await online.DrawFirstScoutAsync()).Ok && online.Pulls.Count == 3 && s.Count("POST", "/v1/gacha/tutorial") == 1, "…and the real 10-pull is drawn now");
        online.FinishFirstScout();
        check(await new OnboardingFlow(b, null, () => now).ResumeAsync() == FtueStep.Home, "after the reveal: home (no loop back)");
    }

    static async Task QaOfflineConsentToOldTerms(Action<bool, string> check, RulesetParams rs)
    {
        var player = new P();
        var (s, b, kv) = Setup(player, rs);
        var flow = new OnboardingFlow(b, null, () => now);
        await flow.ResumeAsync();
        // 同意してはじめる with the 2026-11-01 pages on screen, but the request never reaches the server
        s.Routes["POST /v1/player/consent"] = _ => throw new HttpRequestException("connection reset");
        check((await flow.AcceptConsentAsync()).Ok && flow.HasPendingConsent, "consent without an answer is kept on the device (the tutorial starts)");

        // next launch: the terms were updated in between
        player.Terms = "2026-12-01";
        int tried = s.Count("POST", "/v1/player/consent");
        s.Routes["POST /v1/player/consent"] = _ => { player.ConsentRequired = false; player.ConsentedTerms = player.Terms; return Ok("{\"termsVersion\":\"2026-12-01\",\"privacyVersion\":\"2026-12-01\",\"current\":{\"termsVersion\":\"2026-12-01\",\"privacyVersion\":\"2026-12-01\"},\"required\":false}"); };
        var (_, b2, _) = Setup(player, rs, kv, s);
        var again = new OnboardingFlow(b2, null, () => now);
        var screen = await again.ResumeAsync();
        check(s.Count("POST", "/v1/player/consent") == tried && screen == FtueStep.Consent && again.ConsentRequired,
            "a consent kept from the 2026-11-01 pages is not sent as consent to 2026-12-01: the consent screen asks again");

        // the same versions still current: the kept consent is sent once
        var p2 = new P();
        var (s2, b3, kv2) = Setup(p2, rs);
        var f2 = new OnboardingFlow(b3, null, () => now);
        await f2.ResumeAsync();
        s2.Routes["POST /v1/player/consent"] = _ => throw new HttpRequestException("connection reset");
        await f2.AcceptConsentAsync();
        s2.Routes["POST /v1/player/consent"] = _ => { p2.ConsentRequired = false; p2.ConsentedTerms = p2.Terms; return Ok("{\"termsVersion\":\"2026-11-01\",\"privacyVersion\":\"2026-11-01\",\"current\":{\"termsVersion\":\"2026-11-01\",\"privacyVersion\":\"2026-11-01\"},\"required\":false}"); };
        int sent = s2.Count("POST", "/v1/player/consent");
        var (_, b4, _) = Setup(p2, rs, kv2, s2);
        var f3 = new OnboardingFlow(b4, null, () => now);
        check(await f3.ResumeAsync() == FtueStep.FirstRace && s2.Count("POST", "/v1/player/consent") == sent + 1 && !f3.HasPendingConsent, "unchanged versions: the kept consent is sent on the next launch");
    }

    // ------------------------------------------------------------------ shop

    static async Task QaShopDeletionAndOnceOnly(Action<bool, string> check, RulesetParams rs)
    {
        var player = Shopper();
        var (s, b, kv) = Setup(player, rs);
        s.Routes["GET /v1/shop/products?mine=1"] = _ => Ok(Products.Replace("{\"products\":[", "{\"products\":[" + StarterProduct + ","));
        s.Routes["GET /v1/shop/offers"] = _ => Ok(Offers);
        var shop = new ShopModel(b, null, () => now);
        await shop.LoadAsync();
        check(shop.CanPurchase && shop.PopupFor(OfferContext.AfterResultClosed) != null, "shop loaded, no deletion");

        // the deletion is scheduled from the settings while the shop model is alive
        player.Deletion = DeleteStep2;
        await b.RefreshAsync();
        check(!shop.CanPurchase && shop.DeletionPending && shop.PopupFor(OfferContext.AfterResultClosed) == null && shop.Cards("coins").All(c => !c.Purchasable),
            "a deletion scheduled after the shop loaded disables buying and the offer sheet at once (no stale guard)");
        player.Deletion = "{\"status\":\"none\"}";
        await b.RefreshAsync();

        // once-only packs only with their offer (the offers leave out what was bought); the daily pack not while one runs
        await shop.LoadAsync();
        check(shop.Cards("recommended").Any(c => c.Id == "starter_pack"), "starter pack on おすすめ while its T2 offer is live");
        s.Routes["GET /v1/shop/offers"] = _ => Ok(Offers.Replace("{\"id\":\"starter_pack\",\"productId\":\"starter_pack\",\"touchpoint\":\"T2\",\"placement\":\"popup\",\"reason\":\"first_4th_or_worse\",\"triggeredAt\":1795575600000,\"viewedAt\":null,\"showPopup\":true,\"endsAt\":null,\"remainingDays\":null},", "")
            .Replace("\"allowance\":{\"active\":false,\"claimedToday\":false,\"queued\":null}", "\"allowance\":" + Allowance));
        await shop.LoadAsync();
        var rec = shop.Cards("recommended");
        check(rec.All(c => c.Id != "starter_pack"), "a bought (or not yet offered) once-only starter pack is not shown as buyable");
        var daily = rec.FirstOrDefault(c => c.Id == "stable_allowance_30d");
        check(daily != null && !daily.Purchasable && daily.DisabledReason != null, "厩舎手当 cannot be bought while one is running (the server answers ALREADY_PURCHASED)");
    }

    // ------------------------------------------------------------------ KPI

    static void QaFtueKpiOnce(Action<bool, string> check, RulesetParams rs)
    {
        var kv = new MemoryKeyValueStore();
        var sent = new List<AnalyticsEvent>();
        bool first = OnboardingFlow.TrackOnce(kv, sent.Add, 1, "race1_start");
        bool second = OnboardingFlow.TrackOnce(kv, sent.Add, 2, "race1_start");
        OnboardingFlow.TrackOnce(kv, sent.Add, 3, "race1_whip");
        check(first && !second && sent.Count == 2, "MuchiApp's FTUE steps go through TrackOnce: a second tutorial ride does not send race1_start again");
        bool threw = false;
        try { OnboardingFlow.TrackOnce(kv, sent.Add, 4, "first_ride"); } catch (ArgumentException) { threw = true; }
        check(threw && !(kv.Get(OnboardingFlow.KeyKpiSent) ?? "").Contains("first_ride"), "an unknown step is refused before it is remembered");

        var b = OfflineBackend(rs, kv);
        var flow = new OnboardingFlow(b, sent.Add, () => now);
        flow.SecondRaceDone(2);
        flow.SecondRaceDone(1);
        var r2 = sent.Where(e => e.Name == "tutorial_step" && e.AtMs == now).ToList(); // the flow's clock
        check(r2.Count == 1, "race2_done (funnel step 7) is sent once");
    }

}
