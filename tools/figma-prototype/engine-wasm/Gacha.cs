// Scout screens of the web prototype on the Unity game layer's own models (unity/Assets/Muchi/Game/GachaModels.cs):
// GachaRevealModel decides the flip order, the summary, badges, material and step-up lines; BannerListModel the period
// lines, countdowns (real end times only) and the pity meter. The inputs are the server domain's own outputs (MuchiLogic).
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices.JavaScript;
using Muchi.Client;
using Muchi.Game;
using Muchi.Net;

public static partial class MuchiRace
{
    private static BannerListModel _banners;

    private static JsonNode Card(RevealCard c)
    {
        var o = JsonNode.Obj();
        o.Set("slot", c.Slot).Set("templateId", c.TemplateId).Set("name", c.Name).Set("rarity", c.Rarity).Set("tier", c.Style.Tier)
            .Set("shape", c.Style.Shape).Set("text", c.Style.Text).Set("spoken", c.Style.SpokenText).Set("color", c.Style.ColorHex).Set("frame", c.Style.Frame)
            .Set("isNew", c.IsNew).Set("duplicate", c.Duplicate).Set("material", c.Material).Set("guaranteed", c.Guaranteed)
            .Set("badge", c.Badge).Set("caption", c.Caption);
        return o;
    }

    /// <summary>The reveal plan of a draw result: cards in flip order (rarest last) and the summary (every result).</summary>
    [JSExport]
    public static string GachaReveal(string drawJson, string namesJson)
    {
        var names = new Dictionary<string, string>();
        var n = JsonNode.Parse(namesJson ?? "{}");
        foreach (var kv in n.Props) names[kv.Key] = kv.Value.AsString();
        var m = new GachaRevealModel(DrawResult.FromJson(drawJson), id => names.TryGetValue(id, out var x) ? x : null);
        var order = JsonNode.Arr();
        foreach (var c in m.RevealOrder) order.Add(Card(c));
        var summary = JsonNode.Arr();
        foreach (var c in m.Summary) summary.Add(Card(c));
        var o = JsonNode.Obj();
        o.Set("order", order).Set("summary", summary).Set("summaryLine", m.SummaryLine).Set("spentLine", m.SpentLine).Set("stepUpLine", m.StepUpLine)
            .Set("best", m.Best.Rarity).Set("newCount", m.NewCount).Set("duplicateCount", m.DuplicateCount).Set("materialTotal", m.MaterialTotal);
        return o.ToString();
    }

    /// <summary>Banner rows (period line, price line, pity meter, carry-over notice, step line) for the scout list.</summary>
    [JSExport]
    public static string GachaBanners(string scheduleJson, string statusJson, double deviceNowMs)
    {
        _banners = new BannerListModel(BannerSchedule.FromJson(scheduleJson), (long)deviceNowMs);
        if (!string.IsNullOrEmpty(statusJson)) _banners.ApplyStatus(GachaStatus.FromJson(statusJson));
        var rows = JsonNode.Arr();
        foreach (var r in _banners.Rows)
        {
            var o = JsonNode.Obj();
            o.Set("id", r.Banner.Id).Set("title", r.Title).Set("priceLine", r.PriceLine).Set("periodLine", r.PeriodLine).Set("hasCountdown", r.HasCountdown)
                .Set("upcoming", r.Upcoming).Set("pityLine", r.PityLine).Set("pityFill", JsonNode.NumRaw(r.PityFill.ToString("0.###", CultureInfo.InvariantCulture)))
                .Set("carryOverNotice", r.CarryOverNotice).Set("stepLine", r.StepLine).Set("countdown", _banners.CountdownText(r, (long)deviceNowMs));
            rows.Add(o);
        }
        var res = JsonNode.Obj();
        res.Set("rows", rows).Set("clockOffsetMs", _banners.ClockOffsetMs);
        return res.ToString();
    }

    /// <summary>Countdown texts of the current rows (null where there is no real end) and whether the list must reload.</summary>
    [JSExport]
    public static string GachaCountdowns(double deviceNowMs)
    {
        var o = JsonNode.Obj();
        var a = JsonNode.Arr();
        if (_banners != null) foreach (var r in _banners.Rows) a.Add(JsonNode.Str(_banners.CountdownText(r, (long)deviceNowMs)));
        o.Set("texts", a).Set("needsRefresh", _banners != null && _banners.NeedsRefresh((long)deviceNowMs));
        return o.ToString();
    }
}
