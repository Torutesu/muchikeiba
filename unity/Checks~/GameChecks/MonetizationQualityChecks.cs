// Quality pass 2 (docs/quality/shop.md): the scout confirmation (ScoutConfirmModel over GET /v1/gacha/:id/options) and the
// purchase receipt (PurchaseReceiptModel over POST /v1/shop/purchase → receipt), on server-shaped bodies: the split is the
// server's, a way the player cannot take is never confirmed, the SR+ ticket confirms on its own table, the receipt's next
// step opens the screen that uses the purchase, KPI once per sheet, no forbidden wording.
using Muchi.Client;
using Muchi.Game;

static class MonetizationQualityChecks
{
    const string Options = "{\"bannerId\":\"pickup_ginga\",\"name\":\"ピックアップ：ギンガノカナタ\",\"status\":\"active\",\"paidOnly\":false,\"stepUp\":false,"
        + "\"wallet\":{\"paid\":300,\"free\":2144},\"ways\":["
        + "{\"id\":\"coins_1\",\"via\":\"coins\",\"count\":1,\"itemId\":null,\"label\":\"1回引く\",\"price\":100,\"pays\":{\"paid\":100,\"free\":0},\"after\":{\"paid\":200,\"free\":2144},\"owned\":null,\"available\":true,\"block\":null,\"shortfall\":null,\"line\":\"有償コイン100枚を使います\",\"pityGain\":1},"
        + "{\"id\":\"coins_10\",\"via\":\"coins\",\"count\":10,\"itemId\":null,\"label\":\"10回引く\",\"price\":1000,\"pays\":{\"paid\":300,\"free\":700},\"after\":{\"paid\":0,\"free\":1444},\"owned\":null,\"available\":true,\"block\":null,\"shortfall\":null,\"line\":\"有償コイン300枚と無償コイン700枚を使います\",\"pityGain\":10},"
        + "{\"id\":\"ticket:gacha_ticket\",\"via\":\"ticket\",\"count\":1,\"itemId\":\"gacha_ticket\",\"label\":\"スカウト券で1回引く\",\"price\":null,\"pays\":null,\"after\":null,\"owned\":2,\"available\":true,\"block\":null,\"shortfall\":null,\"line\":\"スカウト券を1枚使います（コインは使いません）\",\"pityGain\":1}],"
        + "\"srPlus\":{\"itemId\":\"ticket_sr_plus\",\"name\":\"SR以上確定スカウト券\",\"owned\":1,\"line\":\"SR以上確定スカウト券を1枚使います（SR以上が1頭確定・天井ポイントは加算されません）\",\"oddsPath\":\"/v1/items/tickets/ticket_sr_plus/odds\"},"
        + "\"notice\":\"有償コインから先に使われます。\"}";
    const string Short = "{\"bannerId\":\"standard\",\"name\":\"恒常ガチャ\",\"status\":\"active\",\"paidOnly\":false,\"stepUp\":false,\"wallet\":{\"paid\":0,\"free\":400},\"ways\":["
        + "{\"id\":\"coins_10\",\"via\":\"coins\",\"count\":10,\"itemId\":null,\"label\":\"10回引く\",\"price\":1000,\"pays\":null,\"after\":null,\"owned\":null,\"available\":false,\"block\":\"short\",\"shortfall\":600,\"line\":\"コインが600枚足りません\",\"pityGain\":10}],"
        + "\"srPlus\":null,\"notice\":\"有償コインから先に使われます。\"}";
    const string Purchase = "{\"record\":{\"txId\":\"T1\",\"platform\":\"fake\",\"productId\":\"starter_pack\",\"priceYen\":480,\"paidCoinsGranted\":300,\"bonusCoinsGranted\":0,\"at\":1,\"refunded\":false,\"limitBreach\":false},"
        + "\"duplicate\":false,\"wallet\":{\"paid\":300,\"free\":2144,\"total\":2444,\"debt\":0},\"receipt\":{\"txId\":\"T1\",\"productId\":\"starter_pack\",\"name\":\"スターターパック\",\"priceYen\":480,\"at\":1,"
        + "\"lines\":[{\"kind\":\"paid_coins\",\"label\":\"有償コイン300枚\",\"purpose\":null,\"qty\":300},"
        + "{\"kind\":\"item\",\"label\":\"SR以上確定スカウト券×1\",\"purpose\":\"スカウトの画面で使うと、SR以上の馬が1頭来ます（提供割合は券の画面で確認できます）\",\"itemId\":\"ticket_sr_plus\",\"qty\":1},"
        + "{\"kind\":\"item\",\"label\":\"限定勝負服の柄「稲妻」×1\",\"purpose\":\"勝負服の柄が選べるようになります（見た目だけ。ランク戦の能力は変わりません）\",\"itemId\":\"costume_starter\",\"qty\":1}],"
        + "\"wallet\":{\"paid\":300,\"free\":2144},\"next\":{\"action\":\"use_sr_ticket\",\"label\":\"SR以上確定スカウト券を使う\",\"itemId\":\"ticket_sr_plus\",\"pattern\":null},"
        + "\"notes\":[\"購入の記録は「その他」→「購入履歴」でいつでも確かめられます\"]}}";

    public static void Run(Action<bool, string> check)
    {
        var kpi = new List<AnalyticsEvent>();
        var o = ScoutOptions.FromJson(Options);
        check(o.Ways.Count == 3 && o.SrPlusOwned == 1 && o.WalletPaid == 300, "scout options parse: 3 ways, the SR+ ticket, the wallet");

        var ten = ScoutConfirmModel.For(o, "coins_10", kpi.Add, () => 5);
        check(ten != null && ten.SpendLine == "有償コイン300枚と無償コイン700枚を使います", "10-pull confirmation: the server's line names paid and free");
        check(Math.Abs(ten.PaidFraction - 0.3f) < 1e-4 && Math.Abs(ten.FreeFraction - 0.7f) < 1e-4, "the split bar: paid first (0.3), then free (0.7)");
        check(ten.AfterLine.Contains("有償 0") && ten.AfterLine.Contains("無償 1,444") && ten.PityLine == "天井の交換pt ＋10", "the wallet after and the exchange points");
        check(ten.PullLabel == "引く（1,000コイン）" && ten.Notice.Contains("有償コインから先に"), "the pull button says the coins; the spending order under it");
        ten.Shown(); ten.Shown();
        check(ten.Pull() && !ten.Pull(), "a second tap on 引く does nothing");
        ten.Cancel();
        check(kpi.Select(e => e.Name).SequenceEqual(new[] { "scout_confirm", "scout_confirm" }) && kpi[0].PropsJson.Contains("\"view\"") && kpi[1].PropsJson.Contains("\"pull\"") && kpi[1].PropsJson.Contains("\"count\":10"),
            "KPI scout_confirm: one view per sheet, one pull, no cancel after the pull");

        var tk = ScoutConfirmModel.For(o, "ticket:gacha_ticket");
        check(tk != null && tk.Via == "ticket" && tk.AfterLine == "いま 2枚　→　引いた後 1枚" && tk.SplitLine == null && tk.PullLabel == "券を使って引く", "a ticket pull: no coins, the tickets before and after");
        var sr = ScoutConfirmModel.ForSrTicket(o);
        check(sr != null && sr.Via == "sr_ticket" && sr.PityLine == null && sr.OddsLabel == "この券の提供割合を見る" && sr.Kicker == "スカウト券", "the SR+ ticket confirms on its own table, adds no exchange points");

        var s = ScoutOptions.FromJson(Short);
        check(ScoutConfirmModel.For(s, "coins_10") == null && ScoutConfirmModel.RouteFor(s.Way("coins_10")) == ScoutConfirmModel.Route.Shortfall, "short of coins: never confirmed — the shortfall sheet instead");
        check(ScoutConfirmModel.ForSrTicket(s) == null && ScoutConfirmModel.RouteFor(null) == ScoutConfirmModel.Route.Blocked, "no SR+ ticket held → no SR+ sheet");
        check(ScoutConfirmModel.RouteFor(new ScoutWay { Available = false, Block = "closed" }) == ScoutConfirmModel.Route.Blocked, "a closed banner is blocked, not confirmed");
        check(!ten.Texts().Concat(tk.Texts()).Concat(sr.Texts()).Any(t => ShopModel.ForbiddenWords.Any(t.Contains)), "no forbidden wording on the confirmation");

        // the receipt
        var pr = new List<AnalyticsEvent>();
        var receipt = PurchaseReceiptFrom(Purchase);
        check(receipt != null && receipt.Lines.Count == 3 && receipt.Next.Action == "use_sr_ticket", "purchase result parses the receipt (3 lines, next = use the SR+ ticket)");
        var m = new PurchaseReceiptModel(receipt, pr.Add, () => 7);
        check(m.Rows.First().coins && m.Rows.ElementAt(1).sub.Contains("SR以上") && m.WalletLine == "いまの残高　◈ 有償 300　·　◎ 無償 2,144", "receipt rows: coins in gold, each item with what it does; the wallet now");
        m.Shown(); m.Shown();
        check(m.TakeNext() == PurchaseReceiptModel.Target.ScoutSrTicket && m.TakeNext() == PurchaseReceiptModel.Target.ScoutSrTicket, "the next step opens the scout confirmation of the SR+ ticket");
        check(pr.Count == 2 && pr[0].PropsJson.Contains("\"view\"") && pr[1].PropsJson.Contains("\"next\"") && pr[1].PropsJson.Contains("use_sr_ticket"), "KPI purchase_receipt: one view, one next");
        check(PurchaseReceiptModel.TargetOf("wear_silks") == PurchaseReceiptModel.Target.SilksEditor && PurchaseReceiptModel.TargetOf("open_pass") == PurchaseReceiptModel.Target.SeasonPass
            && PurchaseReceiptModel.TargetOf("claim_allowance") == PurchaseReceiptModel.Target.AllowanceClaim && PurchaseReceiptModel.TargetOf("other") == PurchaseReceiptModel.Target.None, "every next action maps to the screen that uses it");
        check(m.WordingProblems().Count == 0, "no forbidden wording on the receipt");
        bool threw = false;
        try { AnalyticsEvent.ScoutConfirm(1, "view", "coins", 5); } catch (ArgumentException) { threw = true; }
        check(threw, "scout_confirm count is 1 or 10 only");
    }

    /// <summary>The purchase response as ApiClient.PurchaseAsync parses it (the parser is internal to Muchi.Client).</summary>
    static PurchaseReceipt PurchaseReceiptFrom(string json)
    {
        var parse = typeof(PurchaseResult).GetMethod("Parse", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        var res = (PurchaseResult)parse.Invoke(null, new object[] { Muchi.Net.JsonNode.Parse(json) });
        return res.Receipt;
    }
}
