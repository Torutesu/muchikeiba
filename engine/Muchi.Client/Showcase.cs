using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-SHOW-001..018: プロフィールのショーケース（トレーナーカード） (server/src/domain/showcase.ts, contracts/protocol.md §62).
    // A player's public card: a featured horse (silks + appearance), up to 3 pinned things they earned, best records, one fixed
    // phrase and a background unlocked by achievements. The server checks ownership on save and again whenever the card is
    // derived or read; the client only shows what it gets. Display only: nothing here moves coins or items.

    public static class ShowcasePinKinds
    {
        public const string Title = "title", Achievement = "achievement", CupTrophy = "cup_trophy", Hall = "hall", GoalRibbon = "goal_ribbon", Tournament = "tournament";
        public static readonly string[] All = { Title, Achievement, CupTrophy, Hall, GoalRibbon, Tournament };
    }

    /// <summary>Where a card was opened (KPI `showcase_view` source, protocol §62.6).</summary>
    public static class ShowcaseSources
    {
        public const string Settings = "settings", Friends = "friends", Rival = "rival", Activity = "activity", CupLobby = "cup_lobby", Spectate = "spectate",
            Hall = "hall", Stable = "stable", Leaderboard = "leaderboard", Team = "team";
        public static readonly string[] All = { Settings, Friends, Rival, Activity, CupLobby, Spectate, Hall, Stable, Leaderboard, Team };
    }

    /// <summary>A pinned (or pinnable) item as the viewer reads it. HorseName / CupName are player-typed (never translated; absent for an under-13 owner).</summary>
    public sealed class ShowcasePin
    {
        public string Kind, Id, Label, Sub, Icon, HorseName, CupName;
        /// <summary>The line the card draws: the player-typed name when there is one, else the label.</summary>
        public string Headline => !string.IsNullOrEmpty(HorseName) ? HorseName : !string.IsNullOrEmpty(CupName) ? CupName : Label;
        internal static ShowcasePin Parse(JsonNode o) => new ShowcasePin
        {
            Kind = J.Str(o, "kind"), Id = J.Str(o, "id"), Label = J.Str(o, "label"), Sub = J.Str(o, "sub"), Icon = J.Str(o, "icon"),
            HorseName = J.Str(o, "horseName"), CupName = J.Str(o, "cupName"),
        };
    }

    public sealed class ShowcaseRecord
    {
        public string TrackId, Course, Time, HorseName;
        public long TimeMs;
        internal static ShowcaseRecord Parse(JsonNode o) => new ShowcaseRecord { TrackId = J.Str(o, "trackId"), Course = J.Str(o, "course"), Time = J.Str(o, "time"), TimeMs = J.Long(o, "timeMs"), HorseName = J.Str(o, "horseName") };
    }

    public sealed class ShowcaseHorse
    {
        public string HorseId, HorseName, Rarity, Sex;
        public Appearance Appearance = new Appearance();
        internal static ShowcaseHorse Parse(JsonNode o) => o == null ? null : new ShowcaseHorse
        {
            HorseId = J.Str(o, "horseId"), HorseName = J.Str(o, "horseName"), Rarity = J.Str(o, "rarity"), Sex = J.Str(o, "sex"),
            Appearance = Appearance.Parse(J.Opt(o, "appearance")) ?? new Appearance(),
        };
    }

    /// <summary>GET /v1/showcase/:playerId (and the editor's preview).</summary>
    public sealed class ShowcaseCard
    {
        public const string StateOk = "ok", StateNeutral = "neutral";
        public string PlayerId, State, DisplayName, TitleId, TitleName, ClassId, Relation, ReportableHorseId;
        public int? Rating;
        public int Races, Wins, Top3;
        public bool HasStats;
        public long? LastSeenAt;
        public Silks Silks;
        public string BackgroundId, BackgroundKey, BackgroundName;
        public string PhraseId, PhraseText;
        public ShowcaseHorse Horse;
        public List<ShowcasePin> Pins = new List<ShowcasePin>();
        public List<ShowcaseRecord> TimeAttack = new List<ShowcaseRecord>();
        public string SeasonId, SeasonClassId, SeasonClassLabel;
        public int TrophyGold, TrophySilver, TrophyBronze;
        public bool Reportable, Young;
        /// <summary>Blocked either way, deleted or banned: only the neutral name, nothing to open, share or report (REQ-SHOW-009/010).</summary>
        public bool IsNeutral => State == StateNeutral;
        public bool IsSelf => Relation == "self";

        public static ShowcaseCard Parse(JsonNode o)
        {
            var st = J.Opt(o, "stats");
            var bg = J.Opt(o, "background");
            var ph = J.Opt(o, "phrase");
            var sc = J.Opt(o, "seasonClass");
            var tr = J.Opt(o, "cupTrophies");
            return new ShowcaseCard
            {
                PlayerId = J.Str(o, "playerId"), State = J.Str(o, "state") ?? StateOk, DisplayName = J.Str(o, "displayName"),
                TitleId = J.Str(o, "titleId"), TitleName = J.Str(o, "titleName"), ClassId = J.Str(o, "classId"), Rating = J.IntN(o, "rating"),
                HasStats = st != null, Races = J.Int(st, "races"), Wins = J.Int(st, "wins"), Top3 = J.Int(st, "top3"), LastSeenAt = J.LongN(o, "lastSeenAt"),
                Silks = Silks.Parse(J.Opt(o, "silks")),
                BackgroundId = J.Str(bg, "id"), BackgroundKey = J.Str(bg, "key"), BackgroundName = J.Str(bg, "backgroundName"),
                PhraseId = J.Str(ph, "id"), PhraseText = J.Str(ph, "phraseText"),
                Horse = ShowcaseHorse.Parse(J.Opt(o, "horse")),
                Pins = J.List(o, "pins", ShowcasePin.Parse), TimeAttack = J.List(o, "timeAttack", ShowcaseRecord.Parse),
                SeasonId = J.Str(sc, "seasonId"), SeasonClassId = J.Str(sc, "classId"), SeasonClassLabel = J.Str(sc, "label"),
                TrophyGold = J.Int(tr, "gold"), TrophySilver = J.Int(tr, "silver"), TrophyBronze = J.Int(tr, "bronze"),
                Relation = J.Str(o, "relation") ?? "other", Reportable = J.Bool(o, "reportable"), ReportableHorseId = J.Str(o, "reportableHorseId"), Young = J.Bool(o, "young"),
            };
        }
        public static ShowcaseCard FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    public sealed class ShowcasePinRef
    {
        public string Kind, Id;
        public ShowcasePinRef() { }
        public ShowcasePinRef(string kind, string id) { Kind = kind; Id = id; }
        internal static ShowcasePinRef Parse(JsonNode o) => new ShowcasePinRef(J.Str(o, "kind"), J.Str(o, "id"));
    }

    /// <summary>What PUT /v1/showcase sends: ids only (the server checks every one against the player's state).</summary>
    public sealed class ShowcaseSelection
    {
        public const int HardPinsMax = 3, HardTaMax = 3;
        public string HorseId, PhraseId, BackgroundId = "dawn";
        public List<ShowcasePinRef> Pins = new List<ShowcasePinRef>();
        public List<string> TaTrackIds = new List<string>();

        internal static ShowcaseSelection Parse(JsonNode o) => new ShowcaseSelection
        {
            HorseId = J.Str(o, "horseId"), PhraseId = J.Str(o, "phraseId"), BackgroundId = J.Str(o, "backgroundId") ?? "dawn",
            Pins = J.List(o, "pins", ShowcasePinRef.Parse), TaTrackIds = J.List(o, "taTrackIds", v => v.AsString()),
        };

        /// <summary>Why this selection cannot be sent as it is (null = fine). Ownership is the server's to check.</summary>
        public string Problem(int pinsMax = HardPinsMax, int taMax = HardTaMax)
        {
            if (Pins.Count > Math.Min(pinsMax, HardPinsMax)) return "pins";
            if (Pins.Any(p => Array.IndexOf(ShowcasePinKinds.All, p.Kind) < 0 || string.IsNullOrEmpty(p.Id))) return "pin";
            if (Pins.Select(p => p.Kind + ":" + p.Id).Distinct().Count() != Pins.Count) return "duplicate";
            if (TaTrackIds.Count > Math.Min(taMax, HardTaMax) || TaTrackIds.Distinct().Count() != TaTrackIds.Count) return "courses";
            if (string.IsNullOrEmpty(BackgroundId)) return "background";
            return null;
        }

        public JsonNode ToJson()
        {
            var pins = JsonNode.Arr();
            foreach (var p in Pins) pins.Add(JsonNode.Obj().Set("kind", p.Kind).Set("id", p.Id));
            var ta = JsonNode.Arr();
            foreach (var t in TaTrackIds) ta.Add(JsonNode.Str(t));
            return JsonNode.Obj().Set("horseId", HorseId).Set("pins", pins).Set("taTrackIds", ta).Set("phraseId", PhraseId).Set("backgroundId", BackgroundId);
        }

        public ShowcaseSelection Clone() => new ShowcaseSelection
        {
            HorseId = HorseId, PhraseId = PhraseId, BackgroundId = BackgroundId,
            Pins = Pins.Select(p => new ShowcasePinRef(p.Kind, p.Id)).ToList(), TaTrackIds = new List<string>(TaTrackIds),
        };
    }

    public sealed class ShowcaseBackground
    {
        public string Id, Key, Name, UnlockText;
        public bool Unlocked;
        internal static ShowcaseBackground Parse(JsonNode o) => new ShowcaseBackground { Id = J.Str(o, "id"), Key = J.Str(o, "key"), Name = J.Str(o, "backgroundName"), UnlockText = J.Str(o, "unlockText"), Unlocked = J.Bool(o, "unlocked") };
    }

    public sealed class ShowcasePhrase
    {
        public string Id, Text;
        internal static ShowcasePhrase Parse(JsonNode o) => new ShowcasePhrase { Id = J.Str(o, "id"), Text = J.Str(o, "phraseText") };
    }

    /// <summary>GET / PUT /v1/showcase: the saved selection, every choice the player has, and the live preview.</summary>
    public sealed class ShowcaseEditor
    {
        public bool Saved, Young;
        public ShowcaseSelection Selection = new ShowcaseSelection();
        public int PinsMax = 3, TaMax = 2;
        public List<ShowcaseHorse> Horses = new List<ShowcaseHorse>();
        public List<ShowcasePin> Pins = new List<ShowcasePin>();
        public List<ShowcaseRecord> Courses = new List<ShowcaseRecord>();
        public List<ShowcasePhrase> Phrases = new List<ShowcasePhrase>();
        public List<ShowcaseBackground> Backgrounds = new List<ShowcaseBackground>();
        public ShowcaseCard Preview;
        public string Notice;

        public static ShowcaseEditor Parse(JsonNode o)
        {
            var lim = J.Opt(o, "limits");
            return new ShowcaseEditor
            {
                Saved = J.Bool(o, "saved"), Young = J.Bool(o, "young"), Selection = ShowcaseSelection.Parse(J.Opt(o, "selection")),
                PinsMax = J.Int(lim, "pinsMax", 3), TaMax = J.Int(lim, "taMax", 2),
                Horses = J.List(o, "horses", ShowcaseHorse.Parse), Pins = J.List(o, "pins", ShowcasePin.Parse), Courses = J.List(o, "courses", ShowcaseRecord.Parse),
                Phrases = J.List(o, "phrases", ShowcasePhrase.Parse), Backgrounds = J.List(o, "backgrounds", ShowcaseBackground.Parse),
                Preview = J.Opt(o, "preview") is JsonNode p ? ShowcaseCard.Parse(p) : null, Notice = J.Str(o, "notice"),
            };
        }
        public static ShowcaseEditor FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    /// <summary>
    /// REQ-SHOW-013: the trainer card share image through the existing <see cref="ShareCard"/> path (watermark 「ムチ一閃」,
    /// #ムチ一閃). Only the display name, the card's own texts (already in the viewer's language) and the owner's horse names;
    /// never a player id, a rating history or anything about other players. A neutral card cannot be shared.
    /// </summary>
    public static class ShowcaseShare
    {
        public const string Kind = "showcase_card";
        public const string HeaderJa = "トレーナーカード";

        public static ShareCard Build(ShowcaseCard card)
        {
            if (card == null) throw new ArgumentNullException(nameof(card));
            if (card.IsNeutral) throw new InvalidOperationException("a neutral card is not shared");
            var c = new ShareCard { Kind = Kind, ModeLabel = Loc.T(HeaderJa), PlaceText = card.DisplayName ?? "", HorseName = card.Horse?.HorseName ?? "", CourseName = null, TimeMs = -1, TimeText = null };
            if (!string.IsNullOrEmpty(card.TitleName)) c.Lines.Add(card.TitleName);
            if (!string.IsNullOrEmpty(card.SeasonClassLabel)) c.Lines.Add(card.SeasonClassLabel);
            if (!string.IsNullOrEmpty(card.PhraseText)) c.Lines.Add(card.PhraseText);
            foreach (var p in card.Pins) c.Lines.Add(p.Headline + "　" + p.Sub);
            foreach (var r in card.TimeAttack) c.Lines.Add(r.Course + "　" + r.Time);
            var parts = new List<string> { c.ModeLabel, c.PlaceText };
            if (!string.IsNullOrEmpty(card.PhraseText)) parts.Add(card.PhraseText);
            parts.Add(ShareCard.Hashtag);
            c.ShareText = string.Join("　", parts.Where(x => !string.IsNullOrEmpty(x)));
            return c;
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-SHOW-003: my selection, every choice and the preview (the request's language).</summary>
        public Task<ShowcaseEditor> GetShowcaseAsync(CancellationToken ct = default) => Call("GET", "/v1/showcase", null, true, null, true, ShowcaseEditor.Parse, ct);

        /// <summary>REQ-SHOW-003: save (a replace, so safe to retry). Refused: NOT_ELIGIBLE (not earned / locked), HORSE_NOT_FOUND, HORSE_NOT_ACTIVE.</summary>
        public Task<ShowcaseEditor> SaveShowcaseAsync(ShowcaseSelection selection, CancellationToken ct = default)
        {
            if (selection == null) throw new ArgumentNullException(nameof(selection));
            var p = selection.Problem();
            if (p != null) throw new ArgumentException("bad selection: " + p, nameof(selection));
            return Call("PUT", "/v1/showcase", selection.ToJson(), true, null, true, ShowcaseEditor.Parse, ct);
        }

        /// <summary>REQ-SHOW-007: another player's card (blocked / deleted / banned → a neutral card, never an error).</summary>
        public Task<ShowcaseCard> GetShowcaseCardAsync(string playerId, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(playerId)) throw new ArgumentException("player id", nameof(playerId));
            return Call("GET", "/v1/showcase/" + Seg(playerId), null, true, null, true, ShowcaseCard.Parse, ct);
        }
    }

    public sealed partial class AnalyticsEvent
    {
        /// <summary>REQ-SHOW-015: a card was opened (where from, whose, neutral or not). Never the other player's id.</summary>
        public static AnalyticsEvent ShowcaseView(long atMs, string source, string relation, bool neutral)
        {
            if (Array.IndexOf(ShowcaseSources.All, source) < 0) throw new ArgumentException("unknown showcase source " + source);
            if (relation != "self" && relation != "friend" && relation != "other") throw new ArgumentException("unknown relation " + relation);
            return new AnalyticsEvent("showcase_view", atMs, JsonNode.Obj().Set("source", source).Set("relation", relation).Set("neutral", neutral));
        }

        /// <summary>REQ-SHOW-015: the card image was handed to the share sheet (how many pins / records it showed, a horse or not).</summary>
        public static AnalyticsEvent ShowcaseShared(long atMs, ShowcaseCard card)
        {
            if (card == null) throw new ArgumentNullException(nameof(card));
            return new AnalyticsEvent("showcase_share", atMs, JsonNode.Obj().Set("pins", Math.Min(3, card.Pins.Count)).Set("records", Math.Min(4, card.TimeAttack.Count + (card.SeasonClassId != null ? 1 : 0))).Set("horse", card.Horse != null));
        }
    }
}
