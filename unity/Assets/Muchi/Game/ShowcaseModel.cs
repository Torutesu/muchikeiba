using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-SHOW-001..018 (contracts/protocol.md §62, docs/handoff-codex-round21-profile-showcase.md): プロフィールのショーケース
    // （トレーナーカード）, the game layer. Pure C#: Codex's card view (opened from friends, rivals, activity, the cup lobby,
    // spectating, the hall, the stable visit, leaderboards) and the editor in Settings bind to the public members.
    // The server checks what may be shown (owned / earned, blocks, deleted / banned, under-13 names) — the model never shows
    // anything the response does not carry. Horse, cup and display names are what players typed: never through Loc.T. The
    // card's texts come from the server in the request's language; the labels here are in ui-en.json.

    /// <summary>One line of the card (a pin or a record) as the view draws it.</summary>
    public sealed class ShowcaseLine
    {
        public string Kind, Headline, Sub, Icon;
        /// <summary>The headline is player-typed (horse / cup name): draw it as it is in every language.</summary>
        public bool PlayerText;
    }

    /// <summary>
    /// The card view. Rules the model keeps for the screens:
    ///  - a neutral card (blocked either way, deleted, banned) shows only the neutral name: no share, no report, no lines;
    ///  - Report is shown on another player's card (source profile; the horse name only when the card shows one);
    ///  - Share builds the image through ShowcaseShare (display name and the card's own texts; never a player id);
    ///  - KPI showcase_view once per open (source, relation, neutral), showcase_share when the image is handed to the share sheet.
    /// </summary>
    public sealed class ShowcaseCardModel : ScreenModel
    {
        public const string Title = "トレーナーカード";
        public const string HorseLabel = "愛馬";
        public const string NoHorseText = "愛馬はまだ選ばれていません";
        public const string PinsLabel = "ピン留め";
        public const string RecordsLabel = "ベスト記録";
        public const string ShareLabel = "画像で共有";
        public const string ReportLabel = "通報する";
        public const string EditLabel = "カードを編集";
        public const string NeutralText = "このカードは表示できません";
        public const string OfflineText = "トレーナーカードはオンラインで見られます";

        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;

        public ShowcaseCardModel(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null, IKeyValueStore store = null) : base(backend, store ?? backend?.Store)
        {
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public ShowcaseCard Card { get; private set; }
        public List<ShowcaseLine> Pins { get; private set; } = new List<ShowcaseLine>();
        public List<ShowcaseLine> Records { get; private set; } = new List<ShowcaseLine>();

        public bool IsNeutral => Card != null && Card.IsNeutral;
        public bool CanShare => Card != null && !Card.IsNeutral;
        public bool CanReport => Card != null && !Card.IsNeutral && Card.Reportable;
        public bool CanEdit => Card != null && Card.IsSelf;
        /// <summary>The horse name (as typed), or 「愛馬」 when the card shows a horse without a name (under-13 owner).</summary>
        public string HorseTitle => Card?.Horse == null ? null : string.IsNullOrEmpty(Card.Horse.HorseName) ? HorseLabel : Card.Horse.HorseName;

        /// <summary>REQ-SHOW-007: open a player's card from a screen (ShowcaseSources). Offline keeps nothing stale: the card needs the server.</summary>
        public async Task<ActionResult> OpenAsync(string playerId, string source, CancellationToken ct = default)
        {
            Message = null;
            if (Array.IndexOf(ShowcaseSources.All, source) < 0) throw new ArgumentException("unknown source " + source, nameof(source));
            if (!ServerAvailable) { Online = false; return Offline(OfflineText); }
            try
            {
                Use(await B.Api.GetShowcaseCardAsync(playerId, ct));
                Online = true;
                _track?.Invoke(AnalyticsEvent.ShowcaseView(_now(), source, Card.Relation ?? "other", Card.IsNeutral));
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public void Use(ShowcaseCard c)
        {
            Card = c;
            Pins = c == null || c.IsNeutral ? new List<ShowcaseLine>() : c.Pins.Select(LineOf).ToList();
            Records = new List<ShowcaseLine>();
            if (c == null || c.IsNeutral) return;
            foreach (var r in c.TimeAttack) Records.Add(new ShowcaseLine { Kind = "time_attack", Headline = r.Course, Sub = r.Time });
            if (!string.IsNullOrEmpty(c.SeasonClassLabel)) Records.Add(new ShowcaseLine { Kind = "season_class", Headline = c.SeasonClassLabel, Sub = c.SeasonClassId });
        }

        public static ShowcaseLine LineOf(ShowcasePin p) => new ShowcaseLine
        {
            Kind = p.Kind, Headline = p.Headline, Sub = p.Sub, Icon = p.Icon, PlayerText = !string.IsNullOrEmpty(p.HorseName) || !string.IsNullOrEmpty(p.CupName),
        };

        /// <summary>REQ-SHOW-013: the share image (null for a neutral card). Call ReportShared() after the share sheet accepted it.</summary>
        public ShareCard BuildShare() => CanShare ? ShowcaseShare.Build(Card) : null;

        public void ReportShared() { if (CanShare) _track?.Invoke(AnalyticsEvent.ShowcaseShared(_now(), Card)); }

        /// <summary>REQ-SHOW-011: what the report sheet may be about (the existing §47 sheet, source profile).</summary>
        public List<ReportTarget> ReportTargets()
        {
            var list = new List<ReportTarget>();
            if (!CanReport) return list;
            list.Add(new ReportTarget(Card.PlayerId, ReportContentKinds.DisplayName));
            if (!string.IsNullOrEmpty(Card.ReportableHorseId)) list.Add(new ReportTarget(Card.PlayerId, ReportContentKinds.HorseName, Card.ReportableHorseId));
            list.Add(new ReportTarget(Card.PlayerId, ReportContentKinds.Player));
            return list;
        }
        public const string ReportSource = ReportSources.Profile;
    }

    /// <summary>
    /// The editor (Settings › トレーナーカード). The draft changes locally; Save sends ids only and shows the server's preview.
    /// Only what the editor lists can be picked (active horses, earned pins, courses with a record, unlocked backgrounds,
    /// the fixed phrases). There is no text field anywhere.
    /// </summary>
    public sealed class ShowcaseEditorModel : ScreenModel
    {
        public const string Title = "トレーナーカードの編集";
        public const string HorseLabel = "愛馬";
        public const string NoHorseLabel = "選ばない";
        public const string PinsLabel = "ピン留め";
        public const string CoursesLabel = "タイムアタックのベスト";
        public const string PhraseLabel = "一言";
        public const string NoPhraseLabel = "なし";
        public const string BackgroundLabel = "背景";
        public const string SaveLabel = "保存する";
        public const string SavedText = "カードを保存しました";
        public const string LockedText = "この背景はまだ解放されていません";
        public const string PinsFullText = "ピン留めはこれ以上できません";
        public const string CoursesFullText = "コースはこれ以上選べません";
        public const string YoungText = "13歳未満のため、馬の名前などはカードに出ません";
        public const string OfflineText = "トレーナーカードはオンラインで編集できます";

        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;

        public ShowcaseEditorModel(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null, IKeyValueStore store = null) : base(backend, store ?? backend?.Store)
        {
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public ShowcaseEditor Editor { get; private set; }
        public ShowcaseSelection Draft { get; private set; } = new ShowcaseSelection();
        public bool Dirty => Editor != null && Draft.ToJson().ToString() != Editor.Selection.ToJson().ToString();

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Online = false; return Offline(OfflineText); }
            try
            {
                Use(await B.Api.GetShowcaseAsync(ct));
                Online = true;
                _track?.Invoke(AnalyticsEvent.ShowcaseView(_now(), ShowcaseSources.Settings, "self", false));
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public void Use(ShowcaseEditor e) { Editor = e; Draft = e?.Selection?.Clone() ?? new ShowcaseSelection(); }

        public bool IsPinned(string kind, string id) => Draft.Pins.Any(p => p.Kind == kind && p.Id == id);

        public void SetHorse(string horseId)
        {
            if (horseId != null && Editor != null && Editor.Horses.All(h => h.HorseId != horseId)) return;
            Draft.HorseId = horseId;
        }

        public ActionResult TogglePin(string kind, string id)
        {
            if (Editor == null) return ActionResult.Error(OfflineText);
            var hit = Draft.Pins.FirstOrDefault(p => p.Kind == kind && p.Id == id);
            if (hit != null) { Draft.Pins.Remove(hit); return ActionResult.Success(); }
            if (Editor.Pins.All(p => p.Kind != kind || p.Id != id)) return ActionResult.Error(UxText.Errors["NOT_ELIGIBLE"]);
            if (Draft.Pins.Count >= Editor.PinsMax) return ActionResult.Error(PinsFullText);
            Draft.Pins.Add(new ShowcasePinRef(kind, id));
            return ActionResult.Success();
        }

        public ActionResult ToggleCourse(string trackId)
        {
            if (Editor == null) return ActionResult.Error(OfflineText);
            if (Draft.TaTrackIds.Remove(trackId)) return ActionResult.Success();
            if (Editor.Courses.All(c => c.TrackId != trackId)) return ActionResult.Error(UxText.Errors["NOT_ELIGIBLE"]);
            if (Draft.TaTrackIds.Count >= Editor.TaMax) return ActionResult.Error(CoursesFullText);
            Draft.TaTrackIds.Add(trackId);
            return ActionResult.Success();
        }

        public void SetPhrase(string phraseId)
        {
            if (phraseId != null && Editor != null && Editor.Phrases.All(p => p.Id != phraseId)) return;
            Draft.PhraseId = phraseId;
        }

        public ActionResult SetBackground(string id)
        {
            var b = Editor?.Backgrounds.FirstOrDefault(x => x.Id == id);
            if (b == null) return ActionResult.Error(UxText.Errors["NOT_ELIGIBLE"]);
            if (!b.Unlocked) return ActionResult.Error(LockedText);
            Draft.BackgroundId = id;
            return ActionResult.Success();
        }

        /// <summary>REQ-SHOW-003: save the draft (a replace; safe to retry). On success the editor (and its preview) is the server's answer.</summary>
        public async Task<ActionResult> SaveAsync(CancellationToken ct = default)
        {
            if (Editor == null) return ActionResult.Error(OfflineText);
            if (!ServerAvailable) return Offline(OfflineText);
            try
            {
                Use(await B.Api.SaveShowcaseAsync(Draft, ct));
                return ActionResult.Success(SavedText);
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }
    }
}
