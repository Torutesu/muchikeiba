// Round 23: レースの見どころ (REQ-HL-*, contracts/protocol.md §72) for the web prototype: the real Muchi.Game HighlightsModel on
// the real engine. The reel opens from the race that just ran (the result screen) or from a replay's data (マイリプレイ, a friend's
// public replay, a link); frames are posed with the same CourseFrame as the replay player. KPI rows the C# model emits are
// queued here and drained by the page (HighlightsKpi) so the shapes are the model's own.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices.JavaScript;
using System.Text;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

public static partial class MuchiRace
{
    private static HighlightsModel _hl;
    private static readonly List<AnalyticsEvent> _hlKpi = new List<AnalyticsEvent>();
    private static long _hlNow;

    private static string HlOpen(HighlightsModel m)
    {
        _hl = m;
        if (m == null) return "{\"available\":false,\"message\":\"" + Esc(Loc.T(HighlightsModel.TextUnplayable)) + "\"}";
        if (!m.Available) return "{\"available\":false,\"message\":\"" + Esc(m.UnavailableText) + "\"}";
        var p = m.Player; var cfg = p.Config;
        var sb = new StringBuilder();
        sb.Append("{\"available\":true,\"totalMs\":").Append(m.Reel.TotalMs).Append(",\"durationMs\":").Append(p.DurationMs).Append(",\"ownSlot\":").Append(p.OwnSlot)
          .Append(",\"playerSlot\":").Append(p.OwnSlot).Append(",\"hash\":\"").Append(p.Result.Hash).Append("\",\"distanceM\":").Append(cfg.Track.DistanceM)
          .Append(",\"surface\":\"").Append(cfg.Track.Surface == Surface.Dirt ? "dirt" : "turf").Append("\",\"transition\":\"").Append(m.Transition)
          .Append("\",\"set\":").Append(HighlightJson.ToJson(m.Set).ToString()).Append(",\"names\":[");
        for (int i = 0; i < cfg.Entrants.Count; i++) { if (i > 0) sb.Append(','); sb.Append('"').Append(Esc(cfg.Entrants[i].Horse.Name)).Append('"'); }
        sb.Append("],\"moments\":[");
        for (int i = 0; i < m.Moments.Count; i++)
        {
            var x = m.Moments[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"index\":").Append(x.Index).Append(",\"rank\":").Append(x.Rank).Append(",\"kind\":\"").Append(x.Kind).Append("\",\"caption\":\"").Append(Esc(x.Caption))
              .Append("\",\"subject\":\"").Append(Esc(x.Subject)).Append("\",\"startMs\":").Append(x.StartMs).Append(",\"endMs\":").Append(x.EndMs).Append(",\"slot\":").Append(x.Slot).Append('}');
        }
        sb.Append(']');
        AppendWorld(sb, cfg, null);
        return sb.Append('}').ToString();
    }

    /// <summary>The result screen: the race that just ran (offline driver), re-simulated to the same hash.</summary>
    [JSExport]
    public static string HighlightsOpenResult(double nowMs, bool reduceMotion)
    {
        _hlNow = (long)nowMs; _hlKpi.Clear(); _hlDrained = 0;
        var m = HighlightsModel.ForDriver(_driver, _templates, _hlKpi.Add, () => _hlNow);
        if (m != null) m.ReduceMotion = reduceMotion;
        return HlOpen(m);
    }

    /// <summary>A replay's data (GET /v1/replays/:raceId/data or a friend's); surface my_replays / friend_replay / link. linkAllowed: own, saved and public.</summary>
    [JSExport]
    public static string HighlightsOpenReplay(string dataJson, string surface, bool linkAllowed, double nowMs, bool reduceMotion)
    {
        _hlNow = (long)nowMs; _hlKpi.Clear(); _hlDrained = 0;
        var d = ReplayData.FromJson(dataJson);
        var m = HighlightsModel.ForReplay(ReplayPlayer.Open(d), surface, _templates, _hlKpi.Add, () => _hlNow);
        m.ReduceMotion = reduceMotion;
        m.RaceId = d.RaceId; m.LinkAllowed = linkAllowed;
        return HlOpen(m);
    }

    /// <summary>next / skip.</summary>
    [JSExport]
    public static string HighlightsControl(string op)
    {
        if (_hl == null || !_hl.Available) return "{}";
        if (op == "next") _hl.Next(); else if (op == "skip") _hl.Skip();
        return "{\"done\":" + B(_hl.Done) + ",\"index\":" + (_hl.Current?.Index ?? -1) + "}";
    }

    /// <summary>Advance the reel by real ms and pose the frame; the current moment's caption, counter, progress and commentary line.</summary>
    [JSExport]
    public static string HighlightsFrame(double realMs, double nowMs)
    {
        if (_hl == null || !_hl.Available) return "{}";
        _hlNow = (long)nowMs;
        _hl.Advance(realMs);
        var f = _hl.Frame();
        var cur = _hl.Current;
        var sb = new StringBuilder(1024);
        sb.Append("{\"t\":").Append(f.TimeMs).Append(",\"done\":").Append(B(_hl.Done)).Append(",\"index\":").Append(cur?.Index ?? -1)
          .Append(",\"progress\":").Append(_hl.ProgressPermille).Append(",\"elapsedMs\":").Append(_hl.Reel.ElapsedMs).Append(",\"counter\":\"").Append(Esc(_hl.CounterText))
          .Append("\",\"caption\":\"").Append(Esc(cur?.Caption)).Append("\",\"subject\":\"").Append(Esc(cur?.Subject)).Append("\",\"camera\":").Append(f.CameraSlot)
          .Append(",\"remainingM\":").Append(F(f.RemainingM)).Append(",\"rank\":").Append(f.Rank).Append(",\"line\":\"");
        // the commentary line playing at this moment (the last one that started inside the window, at or before the frame)
        string line = "";
        foreach (var l in _hl.CurrentLines) if (l.Tick <= f.Tick) line = l.Text;
        sb.Append(Esc(line)).Append("\",\"lines\":").Append(_hl.CurrentLines.Count).Append(",\"horses\":[");
        for (int i = 0; i < f.To.Length; i++)
        {
            var p = _frame.Horse(f.From[i], f.To[i], f.AlphaPermille);
            if (i > 0) sb.Append(',');
            sb.Append('[').Append(F(p.X + _xShift)).Append(',').Append(F(p.Z)).Append(',').Append(F(p.YawDegrees)).Append(',').Append(f.To[i].Rank).Append(',').Append(B(f.To[i].IsWhipActive)).Append(',').Append(B(f.To[i].Departed && !f.To[i].Finished)).Append(",true]");
        }
        var c = _frame.ToWorld(f.Camera);
        sb.Append("],\"cam\":[").Append(F(c.Position.X + _xShift)).Append(',').Append(F(c.Height)).Append(',').Append(F(c.Position.Z)).Append(',')
          .Append(F(c.LookAt.X + _xShift)).Append(',').Append(F(c.LookAtHeight)).Append(',').Append(F(c.LookAt.Z)).Append(',').Append(F(c.FieldOfViewDegrees)).Append(",\"").Append(c.Mode.ToString()).Append("\"]}");
        return sb.ToString();
    }

    /// <summary>The share sheet: the card (top caption, no names / ids) and whether a link can be sent (with its start tick).</summary>
    [JSExport]
    public static string HighlightsShare(string courseName, bool online)
    {
        if (_hl == null || !_hl.Available) return "{\"ok\":false}";
        var c = _hl.Card(string.IsNullOrEmpty(courseName) ? null : courseName);
        var lines = JsonNode.Arr();
        foreach (var l in c.Lines) lines.Add(JsonNode.Str(l));
        var note = _hl.LinkNote(online);
        var o = JsonNode.Obj().Set("ok", true).Set("kind", c.Kind).Set("watermark", c.Watermark).Set("placeText", c.PlaceText).Set("time", c.TimeText).Set("horse", c.HorseName)
            .Set("course", c.CourseName).Set("lines", lines).Set("shareText", c.ShareText).Set("raceId", _hl.RaceId ?? "").Set("startTick", HighlightShare.StartTick(_hl.Set) ?? 0)
            .Set("linkNote", note ?? "");
        return o.ToString();
    }

    private sealed class StillRecorder : IClipRecorder
    {
        public bool SupportsVideo => false;
        public void Begin(ReplayClip clip, ShareCard card) { }
        public System.Threading.Tasks.Task CaptureFrameAsync(ReplayClipFrame frame, System.Threading.CancellationToken ct) => System.Threading.Tasks.Task.CompletedTask;
        public System.Threading.Tasks.Task<string> FinishAsync(System.Threading.CancellationToken ct) => System.Threading.Tasks.Task.FromResult<string>(null);
        public System.Threading.Tasks.Task<string> CaptureStillAsync(ReplayClipFrame frame, ShareCard card, System.Threading.CancellationToken ct) => System.Threading.Tasks.Task.FromResult("highlight.png");
        public void Cancel() { }
    }
    /// <summary>The page already showed its own share confirmation: the sheet "takes" it.</summary>
    private sealed class TakenSheet : IShareSheet
    {
        public string Text;
        public System.Threading.Tasks.Task<bool> ShareAsync(string filePath, string text, System.Threading.CancellationToken ct) { Text = text; return System.Threading.Tasks.Task.FromResult(true); }
    }
    private sealed class GivenLink : IHighlightLinkApi
    {
        public CreatedLink Link;
        public System.Threading.Tasks.Task<CreatedLink> CreateReplayLinkAsync(string raceId, int? startTick, System.Threading.CancellationToken ct = default) => System.Threading.Tasks.Task.FromResult(Link);
    }

    /// <summary>画像で共有 through HighlightsModel.ShareCardAsync (still at the top moment, the card, highlight_share).</summary>
    [JSExport]
    public static string HighlightsShareCard(string courseName, double nowMs)
    {
        if (_hl == null || !_hl.Available) return "{\"ok\":false}";
        _hlNow = (long)nowMs;
        var sheet = new TakenSheet();
        bool ok = _hl.ShareCardAsync(new StillRecorder(), sheet, string.IsNullOrEmpty(courseName) ? null : courseName).GetAwaiter().GetResult();
        return JsonNode.Obj().Set("ok", ok).Set("shareText", sheet.Text ?? "").ToString();
    }

    /// <summary>リンクで送る after the page created the §63 link (L.links.create with the start tick): HighlightsModel.ShareLinkAsync with it.</summary>
    [JSExport]
    public static string HighlightsShareLink(string createdLinkJson, double nowMs)
    {
        if (_hl == null || !_hl.Available) return "{\"ok\":false}";
        _hlNow = (long)nowMs;
        var o = JsonNode.Parse(createdLinkJson);
        var link = new CreatedLink { Token = o.Get("token").AsString(), Url = o.Get("url").AsString(), ShareText = o.Get("shareText").AsString(), Type = "replay" };
        var sheet = new TakenSheet();
        var r = _hl.ShareLinkAsync(new GivenLink { Link = link }, sheet, true).GetAwaiter().GetResult();
        return JsonNode.Obj().Set("ok", r.Ok).Set("message", r.Message ?? "").Set("shareText", sheet.Text ?? "").ToString();
    }

    private static int _hlDrained;

    /// <summary>The KPI rows the model emitted since the last call: [{name, at, props}] for POST /v1/analytics/events.</summary>
    [JSExport]
    public static string HighlightsKpi()
    {
        var arr = JsonNode.Arr();
        for (int i = Math.Min(_hlDrained, _hlKpi.Count); i < _hlKpi.Count; i++)
        {
            var e = _hlKpi[i];
            arr.Add(JsonNode.Obj().Set("name", e.Name).Set("at", e.AtMs).Set("props", JsonNode.Parse(e.PropsJson)));
        }
        _hlDrained = _hlKpi.Count;
        return arr.ToString();
    }
}
