// ガチャの演出と開催カレンダー in the game layer (docs/planning/06 §6.5 / §7 item 7, REQ-GACHA-011..015): reveal order, skip-all,
// summary with every result, rarity by color + shape + text, NEW badge, duplicate → exact material, countdowns only to real
// end times, pity meter and carry-over notice from the server. Offline part uses server-shaped bodies; Online plays a real draw.
using Muchi.Client;
using Muchi.Game;

static class GachaChecks
{
    static string Pull(string tpl, string rarity, string horseId, bool dup, int material, bool guaranteed)
        => "{\"templateId\":\"" + tpl + "\",\"rarity\":\"" + rarity + "\",\"horseId\":" + (horseId == null ? "null" : "\"" + horseId + "\"") + ",\"duplicate\":" + (dup ? "true" : "false")
        + ",\"material\":" + material + ",\"guaranteed\":" + (guaranteed ? "true" : "false") + ",\"appearance\":null}";

    // a step-5 draw of stepup_paid as the server returns it (slot 10 from the step's SSR table; two duplicates)
    static readonly string Draw = "{\"bannerId\":\"stepup_paid\",\"results\":[" + string.Join(",", new[]
    {
        Pull("t_kawarabi", "R", "h1", false, 0, false), Pull("t_ginga", "SSR", null, true, 20, false), Pull("t_kazamidori", "R", "h2", false, 0, false),
        Pull("t_harukaze", "SR", "h3", false, 0, false), Pull("t_kawarabi", "R", null, true, 1, false), Pull("t_yukimi", "R", "h4", false, 0, false),
        Pull("t_natsu", "R", "h5", false, 0, false), Pull("t_kurogane", "SR", "h6", false, 0, false), Pull("t_hayate", "R", "h7", false, 0, false),
        Pull("t_tsukikage", "SSR", "h8", false, 0, true),
    }) + "],\"spent\":{\"paid\":1000,\"free\":0},\"pityPoints\":50,\"stepUp\":{\"drawnStep\":5,\"next\":{\"completed\":5,\"steps\":5,\"afterLast\":\"loop\",\"step\":1,\"round\":2,\"priceTen\":500,\"finalSlotMinRarity\":null}}}";

    const long Now = 1793934000000L; // 2026-11-06 12:00 JST
    const string Banners = "{\"serverNowMs\":1793934000000,\"banners\":["
        + "{\"id\":\"pickup_ginga\",\"name\":\"ピックアップ：ギンガノカナタ\",\"currency\":\"any\",\"priceSingle\":100,\"priceTen\":1000,\"status\":\"active\",\"startAtMs\":1793458800000,\"endAtMs\":1796050800000,\"announceAtMs\":1793199600000,\"lastDay\":\"2026-11-30\",\"daysLeft\":25,\"pityGroup\":\"pickup_ginga\",\"pityLabel\":\"ピックアップ（ギンガノカナタ）\",\"pityCost\":100,\"pityTargets\":[\"t_ginga\"],\"pickup\":{\"templateId\":\"t_ginga\",\"name\":\"ギンガノカナタ\",\"rarity\":\"SSR\"},\"limited\":false,\"stepUp\":null},"
        + "{\"id\":\"stepup_paid\",\"name\":\"有償限定ステップアップ\",\"currency\":\"paidOnly\",\"singleAllowed\":false,\"priceSingle\":null,\"priceTen\":null,\"status\":\"active\",\"startAtMs\":null,\"endAtMs\":null,\"announceAtMs\":null,\"lastDay\":null,\"daysLeft\":null,\"pityGroup\":\"pickup\",\"pityLabel\":\"ピックアップ\",\"pityCost\":100,\"pityTargets\":[\"t_akatsuki\"],\"pickup\":null,\"limited\":false,\"stepUp\":{\"steps\":5,\"afterLast\":\"loop\",\"prices\":[500,1000,1000,1000,1000],\"finalSlotSteps\":[5]}},"
        + "{\"id\":\"standard\",\"name\":\"恒常ガチャ\",\"currency\":\"any\",\"priceSingle\":100,\"priceTen\":1000,\"status\":\"active\",\"startAtMs\":null,\"endAtMs\":null,\"announceAtMs\":null,\"lastDay\":null,\"daysLeft\":null,\"pityGroup\":\"standard\",\"pityLabel\":\"恒常\",\"pityCost\":100,\"pityTargets\":[\"t_akatsuki\",\"t_ginga\",\"t_kohaku\",\"t_tsukikage\"],\"pickup\":null,\"limited\":false,\"stepUp\":null},"
        + "{\"id\":\"winter_2026\",\"name\":\"季節限定：聖夜のセイヤノカネ\",\"currency\":\"any\",\"priceSingle\":100,\"priceTen\":1000,\"status\":\"upcoming\",\"startAtMs\":1796914800000,\"endAtMs\":1799593200000,\"announceAtMs\":1796310000000,\"lastDay\":\"2027-01-10\",\"daysLeft\":null,\"pityGroup\":\"winter_2026\",\"pityLabel\":\"季節限定（聖夜）\",\"pityCost\":100,\"pityTargets\":[\"t_seiya\"],\"pickup\":{\"templateId\":\"t_seiya\",\"name\":\"セイヤノカネ\",\"rarity\":\"SSR\"},\"limited\":true,\"stepUp\":null}]}";
    const string Status = "{\"serverNowMs\":1793934000000,\"groups\":["
        + "{\"group\":\"pickup_ginga\",\"label\":\"ピックアップ（ギンガノカナタ）\",\"points\":37,\"cost\":100,\"remaining\":63,\"exchangeable\":0,\"banners\":[\"pickup_ginga\"],\"targets\":[{\"templateId\":\"t_ginga\",\"name\":\"ギンガノカナタ\",\"owned\":false}],\"closesAtMs\":1796050800000,"
        + "\"carryOver\":{\"atMs\":1796050800000,\"toGroup\":\"standard\",\"toLabel\":\"恒常\",\"rate\":\"1:1\",\"expires\":false,\"toTargets\":[],\"notice\":\"2026-12-01 00:00 JSTに、残っている交換ptはすべて「恒常」の交換ptへ1:1で移ります。失効しません。\"}},"
        + "{\"group\":\"pickup\",\"label\":\"ピックアップ\",\"points\":100,\"cost\":100,\"remaining\":0,\"exchangeable\":1,\"banners\":[\"stepup_paid\"],\"targets\":[],\"closesAtMs\":null,\"carryOver\":null}],"
        + "\"banners\":[{\"bannerId\":\"pickup_ginga\",\"pityGroup\":\"pickup_ginga\",\"points\":37,\"cost\":100,\"remaining\":63,\"coinsToExchange\":6300,\"stepUp\":null},"
        + "{\"bannerId\":\"stepup_paid\",\"pityGroup\":\"pickup\",\"points\":100,\"cost\":100,\"remaining\":0,\"coinsToExchange\":0,\"stepUp\":{\"completed\":4,\"steps\":5,\"afterLast\":\"loop\",\"step\":5,\"round\":1,\"priceTen\":1000,\"finalSlotMinRarity\":\"SSR\"}}]}";

    public static void Run(Action<bool, string> check)
    {
        // ---- reveal
        var names = new Dictionary<string, string> { ["t_ginga"] = "ギンガノカナタ", ["t_tsukikage"] = "ツキカゲロード" };
        var m = new GachaRevealModel(DrawResult.FromJson(Draw), id => names.TryGetValue(id, out var n) ? n : null);
        check(m.Count == 10 && m.Upcoming != null && m.Current == null && m.Progress == "0 / 10", "reveal: 10 cards, nothing face up before the first tap");
        var tiers = m.RevealOrder.Select(c => c.Style.Tier).ToList();
        check(tiers.SequenceEqual(tiers.OrderBy(t => t)) && m.RevealOrder.Last().Rarity == "SSR", "reveal: lower rarities first, the rarest card flips last");
        var rs = m.RevealOrder.Where(c => c.Rarity == "R").Select(c => c.Slot).ToList();
        check(rs.SequenceEqual(rs.OrderBy(x => x)), "reveal: server order kept within a rarity");
        check(m.RevealOrder.Where(c => c.Rarity == "SSR").Select(c => c.Slot).SequenceEqual(new[] { 1, 9 }), "reveal: both SSRs at the end in slot order (the 10th-slot step SSR last)");
        var first = m.Next();
        check(first != null && m.Current == first && m.Progress == "1 / 10" && first.Rarity == "R", "reveal: a tap flips one card");
        var nextUp = m.Upcoming;
        check(nextUp.Style.ColorHex != null && nextUp.Style.Shape.Length > 0, "reveal: the next card's back already shows its rarity light (color + shape)");
        m.Next(); m.Next();
        m.SkipAll();
        check(m.IsSummary && m.Skipped && m.Current == null && m.Next() == null, "reveal: skip-all is one call and lands on the summary");
        check(m.Summary.Count == 10 && m.Summary.Select(c => c.Slot).OrderBy(x => x).SequenceEqual(Enumerable.Range(0, 10)), "summary: every result is on it after a skip (no card hidden)");
        check(m.Summary[0].Rarity == "SSR" && m.Summary[0].Slot == 1, "summary: rarest first, then slot");
        var dup = m.Summary.First(c => c.TemplateId == "t_ginga");
        check(dup.Duplicate && !dup.IsNew && dup.Badge == "ダブり → 覚醒素材 +20", "summary: a duplicate shows its exact material (+20)");
        var nw = m.Summary.First(c => c.TemplateId == "t_tsukikage");
        check(nw.IsNew && nw.Badge == "NEW" && nw.Guaranteed, "summary: a new horse gets the NEW badge (and the guarantee flag)");
        check(m.NewCount == 8 && m.DuplicateCount == 2 && m.MaterialTotal == 21 && m.SummaryLine == "新規 8頭・ダブり 2頭（覚醒素材 +21）", "summary: totals are exact (" + m.SummaryLine + ")");
        check(m.SpentLine == "有償 1,000 コインを使いました", "summary: coins used, paid shown as paid (" + m.SpentLine + ")");
        check(m.StepUpLine == "ステップ5を引きました。次はステップ1（10連 500コイン）", "summary: step-up progress (" + m.StepUpLine + ")");
        check(m.PityLine(100) == "交換pt 50 / 100", "summary: pity points after the scout");
        foreach (var r in new[] { "R", "SR", "SSR" })
        {
            var st = RarityStyle.Of(r);
            check(st.Text == r && st.Shape.Length > 0 && st.Frame != null && st.ColorHex != null, "rarity " + r + ": color + shape (" + st.Shape + ") + text + frame (not color alone)");
        }
        check(new[] { "R", "SR", "SSR" }.Select(r => RarityStyle.Of(r).Shape).Distinct().Count() == 3 && new[] { "R", "SR", "SSR" }.Select(r => RarityStyle.Of(r).Frame).Distinct().Count() == 3, "rarity: shapes and frames differ per tier (readable in grayscale)");
        check(nw.Caption.Contains("★★") && nw.Caption.Contains("SSR（最高レア）") && nw.Caption.Contains("ツキカゲロード"), "card caption for screen readers: " + nw.Caption);
        var tutorial = new GachaRevealModel(DrawResult.FromJson(Draw.Replace("\"paid\":1000", "\"paid\":0")));
        check(tutorial.SpentLine == null, "reveal: a free draw shows no coin line");

        // ---- banner calendar with countdowns only to real end times
        var device = Now - 5000; // device clock 5 s behind the server
        var list = new BannerListModel(BannerSchedule.FromJson(Banners), device);
        check(list.ClockOffsetMs == 5000, "banners: device clock corrected by the server clock");
        var g = list.Rows[0];
        check(g.HasCountdown && g.PeriodLine == "11月30日 23:59まで" && list.CountdownText(g, device) == "残り 24日 12時間", "banners: limited pickup counts down to its real end (" + list.CountdownText(g, device) + ", " + g.PeriodLine + ")");
        var lastSecond = device + (1796050800000L - Now) - 1000;
        check(list.CountdownText(g, lastSecond) == "残り 00:00:01", "banners: last day counts h:m:s to the end");
        check(list.CountdownText(g, lastSecond + 5000) == "終了しました" && list.NeedsRefresh(lastSecond + 1000) && !list.NeedsRefresh(lastSecond), "banners: at the end the timer stops at 0 and the list reloads");
        var std = list.Rows.First(r => r.Banner.Id == "standard");
        check(!std.HasCountdown && list.CountdownText(std, device) == null && std.PeriodLine == "常設", "banners: a permanent banner has no timer (no fake urgency)");
        var win = list.Rows.Last();
        check(win.Upcoming && !win.HasCountdown && list.CountdownText(win, device) == null && win.PeriodLine == "12月11日 0:00から", "banners: an announced banner shows its start date, no timer");
        check(list.Rows.All(r => !(r.PriceLine + r.PeriodLine).Contains("倍")), "banners: no 「倍」 wording");
        var step = list.Rows.First(r => r.Banner.Id == "stepup_paid");
        check(step.PriceLine == "有償コインのみ ・ 10回 500（10連のみ・SR以上1頭確定）", "banners: step-up price line before the status (" + step.PriceLine + ")");
        // QA r9: a banner that sells no single pull never shows a 「1回」 price (server singleAllowed=false, priceSingle null)
        var tenOnly = new Banner { Id = "x", Name = "x", Currency = "any", SingleAllowed = false, PriceTen = 900 };
        check(BannerListModel.PriceText(tenOnly, null) == "10回 900（10連のみ・SR以上1頭確定）", "banners: no single price when singles are not offered (" + BannerListModel.PriceText(tenOnly, null) + ")");

        // ---- pity meter
        list.ApplyStatus(GachaStatus.FromJson(Status));
        check(g.PityLine == "交換pt 37 / 100（あと63回・6,300コイン）" && Math.Abs(g.PityFill - 0.37f) < 1e-6, "pity: meter with pulls and coins to the exchange (" + g.PityLine + ")");
        check(g.CarryOverNotice != null && g.CarryOverNotice.Contains("1:1") && g.CarryOverNotice.Contains("失効しません"), "pity: closing group shows where the points go (never expire)");
        check(step.PityLine == "交換pt 100 / 100（交換できます）" && step.CarryOverNotice == null, "pity: full meter says it can be exchanged; permanent group has no carry-over notice");
        check(step.StepLine == "ステップ 5 / 5 ・ 10連 1,000コイン（10枠目はSSRの表から）" && step.PriceLine.Contains("10回 1,000"), "step-up: progress and the current step price (" + step.StepLine + ")");
        check(BannerListModel.ErrorText(ApiErrorCode.BannerClosed).Contains("終了"), "a refused pull on an ended banner explains it and reloads");
        check(BannerListModel.Offline(GachaBackend.OfflineNotice).LocalOnly, "offline: the scout list says it is online only");
    }

    public static async Task Online(Action<bool, string> check, GameBackend b)
    {
        var gb = new GachaBackend(b);
        var list = await gb.BannersAsync();
        check(!list.LocalOnly && list.Rows.Any(r => r.Banner.Id == "standard"), "online: banner calendar loads (" + string.Join(", ", list.Rows.Select(r => r.Banner.Id)) + ")");
        check(list.Rows.All(r => r.HasCountdown == (r.Banner.EndAtMs.HasValue && !r.Upcoming)), "online: timers only on banners with a real end");
        check(list.Rows.Where(r => !r.Upcoming).All(r => r.PityLine != null), "online: every open banner has its pity meter");
        var (reveal, err, msg) = await gb.DrawAsync("standard", 1, null);
        if (reveal != null)
        {
            reveal.SkipAll();
            check(reveal.Summary.Count == 1 && reveal.IsSummary, "online: a single scout reveals and summarises (" + reveal.SummaryLine + ")");
        }
        else check(err == ApiErrorCode.InsufficientCoins, "online: scout refused with a clear reason (" + msg + ")");
        var (_, e2, m2) = await gb.DrawAsync("stepup_paid", 1, null);
        check(e2 == ApiErrorCode.BadRequest, "online: a single pull on the step-up banner is refused (" + m2 + ")");
    }
}
