// レースの見どころ (REQ-HL-001..020, contracts/protocol.md §72): HighlightsModel on the real engine with a golden replay. The same
// moments as the shared vectors (= the verifier), the result screen gate (no tutorial), the reel (1×, cuts, next / skip,
// counter, progress), captions in Japanese and English with horse names only, commentary inside the windows, the reduce
// motion cut, the card share (KPI only when the sheet takes it), the link row (own public saved replay, online) with the top
// start tick, the link's start time clamped, and a wrong hash showing no reel.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class HighlightsChecks
{
    sealed class Recorder : IClipRecorder
    {
        public ReplayClipFrame Still; public ShareCard Card; public bool Cancelled;
        public bool SupportsVideo => false;
        public void Begin(ReplayClip clip, ShareCard card) { }
        public Task CaptureFrameAsync(ReplayClipFrame frame, CancellationToken ct) => Task.CompletedTask;
        public Task<string> FinishAsync(CancellationToken ct) => Task.FromResult<string>(null);
        public Task<string> CaptureStillAsync(ReplayClipFrame frame, ShareCard card, CancellationToken ct) { Still = frame; Card = card; return Task.FromResult("/tmp/hl.png"); }
        public void Cancel() { Cancelled = true; }
    }
    sealed class Sheet : IShareSheet
    {
        public bool Answer = true; public string Path, Text; public int Calls;
        public Task<bool> ShareAsync(string filePath, string text, CancellationToken ct) { Calls++; Path = filePath; Text = text; return Task.FromResult(Answer); }
    }
    sealed class Links : IHighlightLinkApi
    {
        public string RaceId; public int? StartTick; public bool Gone;
        public Task<CreatedLink> CreateReplayLinkAsync(string raceId, int? startTick, CancellationToken ct = default)
        {
            if (Gone) throw new NotFoundException(ApiErrorCode.NotFound, "NOT_FOUND", "nothing to share", 404);
            RaceId = raceId; StartTick = startTick;
            return Task.FromResult(new CreatedLink { Token = "abcdefghjkmnpqrstuvwxy", Url = "https://link.muchi-issen.example/l/abcdefghjkmnpqrstuvwxy", ShareText = "ムチ一閃のリプレイを見てください\nhttps://link.muchi-issen.example/l/abcdefghjkmnpqrstuvwxy", Type = "replay", Created = true });
        }
    }

    public static async Task Run(Action<bool, string> check, string root)
    {
        var golden = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "contracts", "golden", "race-turf1600-mixed.json")));
        var log = ProtocolCodec.ParseReplayLog(golden.Get("log"));
        string hash = golden.Get("expected").Get("resultHash").AsString();
        var vectors = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "contracts", "highlights.vectors.json")));
        var row = vectors.Get("cases").Items.First(r => r.Get("golden").AsString() == "race-turf1600-mixed.json" && r.Get("focusSlot").AsInt() == 0);
        var templates = CommentaryTemplates.Parse(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "commentary-ja.json")));
        var rows = new List<AnalyticsEvent>();
        long now = 1796698800000L;

        check(HighlightsModel.ShowOnResult(RaceMode.Ranked) && HighlightsModel.ShowOnResult(RaceMode.TimeAttack) && !HighlightsModel.ShowOnResult(RaceMode.Tutorial), "the result screen's 見どころ: every race but the tutorial");

        var m = HighlightsModel.ForResult(log.Config, log.Inputs, hash, 0, templates, rows.Add, () => now);
        check(m.Available && m.UnavailableText == null, "the race that just ran has highlights (offline: from its own log)");
        check(HighlightJson.ToJson(m.Set).ToString() == HighlightJson.ToJson(HighlightJson.Parse(row.Get("expected"))).ToString(), "the same moments as the shared vectors (= the verifier)");
        check(m.Moments.Count == 3 && m.Moments.Count(x => x.Top) == 1, "three moments, one top");
        check(m.Moments.All(x => x.EndMs > x.StartMs) && m.Reel.TotalMs >= 15000 && m.Reel.TotalMs <= 30000, "15–30 s in all");
        check(m.CounterText == "見どころ 1 / 3" && m.Current.Index == 0, "counter 見どころ 1 / 3");
        check(m.Moments.Any(x => x.Caption == "最後の直線で2頭抜き" || x.Caption.EndsWith("頭抜き")) && m.Moments.Any(x => x.Caption.StartsWith("残り")), "captions from the moments (passes, lead change)");
        check(m.Moments.Where(x => x.Slot == 0).All(x => x.Subject.EndsWith("（あなた）")) && m.Moments.Where(x => x.Slot != 0).All(x => !x.Subject.Contains("（あなた）")), "subject: horse names, mine marked");
        check(m.Moments.All(x => !x.Subject.Contains(log.Config.Entrants[x.Slot].PlayerId ?? "\u0000")), "never a player id");
        check(rows.Count == 0, "no KPI before the reel plays");
        m.Advance(500);
        check(rows.Count == 1 && rows[0].Name == "highlight_view" && rows[0].PropsJson == "{\"surface\":\"result\",\"top\":\"" + m.Set.Top.Kind + "\",\"moments\":3}", "highlight_view once when it plays (surface, top kind, count)");
        m.Advance(500);
        check(rows.Count == 1, "…only once");
        check(m.Player.Speed == 1.0 && m.Player.CameraSlot == m.Current.Slot, "1×, the camera on the moment's horse");
        check(m.CurrentLines.All(l => l.Tick >= m.Reel.Current.StartTick && l.Tick <= m.Reel.Current.EndTick), "commentary: only lines inside the window");
        m.Next();
        check(m.Current.Index == 1 && m.Player.CameraSlot == m.Current.Slot && m.CounterText == "見どころ 2 / 3", "次へ: the next moment, a cut to its horse");
        int p = m.ProgressPermille;
        check(p > 0 && p < 1000, "progress between 0 and 1000");
        m.Skip();
        check(m.Done && m.Current == null && m.ProgressPermille == 1000 && m.CounterText == null, "スキップ: the reel ends");
        check(m.Transition == HighlightsModel.TransitionWipe, "a wipe between moments…");
        m.ReduceMotion = true;
        check(m.Transition == HighlightsModel.TransitionCut, "…a plain cut with reduce motion (§41)");

        // share: the card always, the link only for an own public saved replay
        var rec = new Recorder(); var sheet = new Sheet();
        bool shared = await m.ShareCardAsync(rec, sheet, "青葉競馬場");
        check(shared && rec.Card.Kind == HighlightShare.CardKind && rec.Card.Lines.Contains(HighlightCaptions.Headline(m.Set.Top, log.Config)), "画像で共有: the card with the top caption");
        check(rec.Still != null && rec.Still.Tick >= m.Set.Top.StartTick && rec.Still.Tick <= m.Set.Top.EndTick + 1, "the still is the top moment");
        check(rows.Count == 2 && rows[1].PropsJson == "{\"surface\":\"result\",\"via\":\"card\"}", "highlight_share (card) when the sheet takes it");
        sheet.Answer = false;
        await m.ShareCardAsync(rec, sheet);
        check(rows.Count == 2, "no KPI when the sheet is dismissed");
        var links = new Links();
        check(m.LinkNote(true) == HighlightsModel.TextLinkNote, "a race that is not saved: 「保存して公開すると、リンクで送れます」");
        var refused = await m.ShareLinkAsync(links, sheet, true);
        check(!refused.Ok && links.RaceId == null, "…and no link is asked for");
        m.RaceId = "r-1"; m.LinkAllowed = true;
        check(m.LinkNote(false) == HighlightsModel.TextLinkOffline, "offline: the link waits for the network");
        sheet.Answer = true;
        var ok = await m.ShareLinkAsync(links, sheet, true);
        check(ok.Ok && links.RaceId == "r-1" && links.StartTick == m.Set.Top.StartTick && sheet.Path == null && sheet.Text.Contains("/l/"), "リンクで送る: the replay link opening at the top moment");
        check(rows.Count == 3 && rows[2].PropsJson == "{\"surface\":\"result\",\"via\":\"link\"}", "highlight_share (link)");
        links.Gone = true;
        var gone = await m.ShareLinkAsync(links, sheet, true);
        check(!gone.Ok && !m.LinkAllowed, "made private meanwhile: back to the note");

        // a replay opened from a link starts at its tick (clamped)
        var data = new ReplayData { RaceId = "r-1", Owner = "friend", ResultHash = hash, FocusSlot = 3, Playable = true, Log = log };
        var player = ReplayPlayer.Open(data);
        var link = ResolvedLink.Parse(JsonNode.Parse("{\"state\":\"ok\",\"type\":\"replay\",\"screen\":\"friend_replay\",\"target\":{\"ownerId\":\"u\",\"raceId\":\"r-1\",\"startTick\":" + m.Set.Top.StartTick + "}}"));
        check(HighlightsModel.LinkStartMs(link, player) == m.Set.Top.StartTick * 50, "a link opens the replay at the shared moment");
        var friend = HighlightsModel.ForReplay(player, "link", null, rows.Add, () => now);
        check(friend.Available && friend.Set.FocusSlot == 3, "the friend's reel: the owner's horse is the focus");

        // a wrong hash: no reel, never a different race
        var bad = HighlightsModel.ForResult(log.Config, log.Inputs, new string('0', 64), 0);
        check(!bad.Available && bad.UnavailableText == HighlightsModel.TextUnplayable && bad.Card() == null && bad.Frame() == null, "a wrong hash: 見どころを再生できません");

        // English
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        Loc.SetLocale("en");
        try
        {
            var en = HighlightsModel.ForResult(log.Config, log.Inputs, hash, 0);
            check(en.Moments.All(x => !Loc.HasJapanese(x.Caption)), "English captions: " + string.Join(" | ", en.Moments.Select(x => x.Caption)));
            check(en.CounterText == "Highlight 1 / 3" && en.Moments.Where(x => x.Slot == 0).All(x => x.Subject.EndsWith(" (you)")), "English counter and (you)");
            foreach (var t in new[] { HighlightsModel.TextTitle, HighlightsModel.TextUnplayable, HighlightsModel.TextNone, HighlightsModel.TextLinkNote, HighlightsModel.TextLinkOffline, HighlightsModel.TextShare, HighlightsModel.TextShareCard, HighlightsModel.TextShareLink, HighlightsModel.TextNext, HighlightsModel.TextSkip })
                check(!Loc.HasJapanese(Loc.T(t)), "English: " + t + " → " + Loc.T(t));
        }
        finally { Loc.SetLocale("ja"); }
    }
}
