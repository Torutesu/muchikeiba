// Round 21: トレーナーカード (REQ-SHOW-013, contracts/protocol.md §62.7) for the web prototype: the share image is built by the
// real Muchi.Client ShowcaseShare (the ShareCard path of the replay / photo / recap shares) from the card JSON the server
// returned (GET /v1/showcase/:playerId, in the viewer's language). The page draws what this returns; a neutral card returns
// ok: false. Never a player id: the C# builder takes the display name and the card's own texts only.
using System;
using System.Runtime.InteropServices.JavaScript;
using Muchi.Client;
using Muchi.Net;

public static partial class MuchiRace
{
    [JSExport]
    public static string ShowcaseShareCard(string cardJson)
    {
        var card = ShowcaseCard.FromJson(cardJson);
        if (card.IsNeutral) return "{\"ok\":false}";
        var c = ShowcaseShare.Build(card);
        var lines = JsonNode.Arr();
        foreach (var l in c.Lines) lines.Add(JsonNode.Str(l));
        int records = Math.Min(4, card.TimeAttack.Count + (card.SeasonClassId != null ? 1 : 0));
        return JsonNode.Obj().Set("ok", true).Set("kind", c.Kind).Set("watermark", c.Watermark).Set("mode", c.ModeLabel).Set("name", c.PlaceText)
            .Set("horse", c.HorseName).Set("lines", lines).Set("shareText", c.ShareText)
            .Set("pins", Math.Min(3, card.Pins.Count)).Set("records", records).Set("hasHorse", card.Horse != null).ToString();
    }
}
