using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    // REQ-PRAC-001..018 練習レース (contracts/protocol.md §50, docs/handoff-codex-round18-practice.md). Pure C#: Codex's
    // practice setup / race / result screens bind to the public members.
    //
    // Rules the model keeps:
    //  - the race runs on the device (PracticeSession → OfflineRace → OfflineRaceDriver): the same HUD, commentary, easy
    //    controls and whip hold as any offline race; it works offline (the stored catalog, else the built-in fallback);
    //  - practice grants nothing: the model has no reward call, no submit, no "save replay", no replay share card;
    //  - it opens only after the FTUE (it never competes with the first-race flow) and never prompts by itself;
    //  - §41: text size via AccessibilityModel, the whip hold applied to the race input, reduced motion = instant switches,
    //    the whip band colour is the a11y token cue.whipChance;
    //  - KPI practice_start on every start, practice_finish once per finished attempt (course / field / strength only).

    public sealed class PracticeChoice
    {
        public string Id, Label, Detail;
        public bool Selected, Enabled = true, Partner;
    }

    /// <summary>What the race HUD draws on top of the usual HUD each frame (§50.4).</summary>
    public sealed class PracticeFrame
    {
        /// <summary>The whip band on the remaining-distance bar (null when the option is off).</summary>
        public int? BandFromM, BandToM;
        /// <summary>The player's horse is inside the band (the band brightens; it never blinks).</summary>
        public bool InBand;
        /// <summary>Last 400 m slow motion is running.</summary>
        public bool Slow;
        /// <summary>The ghost (previous attempt): its label and gap in metres (+ = ahead). Null without a ghost.</summary>
        public string GhostLabel;
        public double? GhostGapM;
        /// <summary>Colour token of the band (contracts/a11y-tokens.json), resolved for the player's colour setting.</summary>
        public string BandColor;
    }

    public sealed class PracticeResultView
    {
        public bool Finished;
        public int Place, Runners;
        public string PlaceText, TimeText;
        /// <summary>Debrief line + tip, the advice line, the ghost line and 「報酬はありません（練習）」 (always last), in the app's language.</summary>
        public List<string> Lines = new List<string>();
        /// <summary>Buttons in order: same_seed, new_seed, change, photo. Never save_replay or share (§50.7).</summary>
        public List<string> Buttons = new List<string>();
    }

    public sealed class PracticeModel : ScreenModel
    {
        public const string KeySetup = "muchi.practice.setup";
        public const string Title = PracticeTexts.Title;
        public const string ButtonSameSeed = "同じ展開でもう一度";
        public const string ButtonNewSeed = "新しい相手で";
        public const string ButtonChange = "条件を変える";
        public const string ButtonPhoto = "この瞬間を撮る";
        public const string Lead = "自分の馬で、CPU 相手にムチと脚質を練習できます";
        public const string OptionWhip = "ムチの目安を出す";
        public const string OptionSlow = "最後の400mをスロー";
        public const string OptionGhost = "前回のゴーストを出す";
        public const string FtueLocked = "チュートリアルのあとで遊べます";
        public static readonly string[] ResultButtons = { "same_seed", "new_seed", "change", "photo" };

        private readonly Func<bool> _inFtue;
        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;
        private bool _finishSent;

        public PracticeModel(GameBackend backend, Func<bool> inFtue = null, Action<AnalyticsEvent> track = null, NowMs now = null) : base(backend, backend?.Store)
        {
            _inFtue = inFtue ?? (() => false);
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Options = PracticeOptions.Decode(Kv.Get(PracticeOptions.StorageKey));
        }

        /// <summary>§50.8: after the FTUE, any time (no server unlock key, never a prompt).</summary>
        public bool Available => !_inFtue();
        public PracticeCatalog Catalog { get; private set; }
        public PracticeSetup Setup { get; private set; }
        public PracticeOptions Options { get; private set; }
        public PracticeSession Session { get; private set; }
        public OfflineRaceDriver Driver { get; private set; }
        public RaceObserver Observer { get; private set; }
        /// <summary>かんたん操作 for the next race (the server setting, AssistModel) — practice is an offline race, so it applies.</summary>
        public AssistLevel Assist { get; set; } = AssistLevel.Off;
        public string Problem => Setup == null ? PracticeTexts.NoCatalog : Setup.Problem(Catalog);
        public bool CanStart => Available && Problem == null;

        /// <summary>Loads the catalog: the server's (stored for offline), else the stored copy, else the built-in fallback (§50.6).</summary>
        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            PracticeCatalog c = null;
            if (ServerAvailable)
            {
                try
                {
                    c = await B.Api.GetPracticeCatalogAsync(ct);
                    Kv.Set(PracticeCatalog.StorageKey, c.Raw);
                    Online = true;
                }
                catch (ApiException e) { Message = UxText.For(e); }
            }
            if (c == null)
            {
                Online = false;
                var stored = Kv.Get(PracticeCatalog.StorageKey);
                if (!string.IsNullOrEmpty(stored)) { try { c = PracticeCatalog.FromJson(stored); } catch (Exception) { c = null; } }
                if (c != null && c.Ruleset == null) c = null;
                if (c == null) c = PracticeCatalog.Fallback(B.Ruleset, null);
            }
            if (c.Horses.Count == 0) c.Horses.Add(new PracticeHorse { Spec = RaceFactory.FromServer(B.Partner), Partner = true });
            Use(c);
            return Message == null ? ActionResult.Success() : ActionResult.Error(Message);
        }

        /// <summary>Uses a catalog directly (tests, the prototype).</summary>
        public void Use(PracticeCatalog c)
        {
            Catalog = c ?? throw new ArgumentNullException(nameof(c));
            var remembered = PracticeSetup.Decode(Kv.Get(KeySetup));
            Setup = remembered != null && remembered.Problem(c) == null ? remembered : PracticeSetup.Default(c);
            Session = null;
        }

        // ------------------------------------------------------------------ choices (setup screen)

        public List<PracticeChoice> Horses
        {
            get
            {
                var o = new List<PracticeChoice>();
                if (Catalog == null) return o;
                foreach (var h in Catalog.Horses)
                    o.Add(new PracticeChoice
                    {
                        Id = h.Id, Label = h.Name, Partner = h.Partner, Selected = h.Id == Setup?.HorseId,
                        Detail = Loc.T(RaceFactory.StyleLabel(Muchi.Net.ProtocolCodec.StyleToString(h.Spec.Style))) + "  " + DistanceText(h.Spec.DistMinM) + "–" + DistanceText(h.Spec.DistMaxM),
                    });
                return o;
            }
        }

        public List<PracticeChoice> Courses
        {
            get
            {
                var o = new List<PracticeChoice>();
                if (Catalog == null) return o;
                foreach (var c in Catalog.Courses)
                    o.Add(new PracticeChoice { Id = c.TrackId, Label = Loc.T(c.Name), Selected = c.TrackId == Setup?.TrackId, Detail = c.Lights ? Loc.T("ナイターあり") : null });
                return o;
            }
        }

        public List<PracticeChoice> Goings
        {
            get
            {
                var o = new List<PracticeChoice>();
                var c = Catalog?.Course(Setup?.TrackId);
                if (c == null) return o;
                foreach (var g in c.Goings)
                    o.Add(new PracticeChoice { Id = g, Label = Loc.T(RaceAdvice.GoingJa.TryGetValue(g, out var ja) ? ja : g), Selected = g == Setup.Going, Detail = g == c.TodayGoing ? Loc.T("今日の馬場") : null });
                return o;
            }
        }

        /// <summary>Night is offered only on courses with lights.</summary>
        public bool NightAvailable => Catalog?.Course(Setup?.TrackId)?.Lights == true;

        public List<PracticeChoice> FieldSizes
        {
            get
            {
                var o = new List<PracticeChoice>();
                if (Catalog == null) return o;
                for (int n = Catalog.FieldMin; n <= Catalog.MaxField; n++)
                    o.Add(new PracticeChoice { Id = n.ToString(CultureInfo.InvariantCulture), Label = Loc.T(n.ToString(CultureInfo.InvariantCulture) + "頭"), Selected = n == Setup?.FieldSize });
                return o;
            }
        }

        public List<PracticeChoice> Strengths
        {
            get
            {
                var o = new List<PracticeChoice>();
                if (Catalog == null) return o;
                foreach (var s in Catalog.Strengths) o.Add(new PracticeChoice { Id = s.Id, Label = Loc.T(s.Name), Detail = Loc.T(s.Note), Selected = s.Id == Setup?.StrengthId });
                return o;
            }
        }

        private static string DistanceText(int m) => m.ToString("N0", CultureInfo.InvariantCulture) + "m";

        public void SelectHorse(string id) => Change(s => s.HorseId = id);
        public void SelectGoing(string going) => Change(s => s.Going = going);
        public void SelectNight(bool night) => Change(s => s.Night = night && NightAvailable);
        public void SelectFieldSize(int n) => Change(s => s.FieldSize = n);
        public void SelectStrength(string id) => Change(s => s.StrengthId = id);
        /// <summary>A new course starts on its today's ground and by day when it has no lights.</summary>
        public void SelectCourse(string trackId)
        {
            var c = Catalog?.Course(trackId);
            if (c == null) return;
            Change(s => { s.TrackId = trackId; s.Going = c.TodayGoing; s.Night = c.Lights && s.Night; });
        }

        private void Change(Action<PracticeSetup> f)
        {
            if (Setup == null) return;
            var next = Setup.Clone();
            f(next);
            Setup = next;
            if (Setup.Problem(Catalog) == null) Kv.Set(KeySetup, Setup.Encode());
        }

        public void SetOptions(bool whipWindow, bool slowFinal, bool ghost)
        {
            Options.WhipWindow = whipWindow; Options.SlowFinal = slowFinal; Options.Ghost = ghost;
            Kv.Set(PracticeOptions.StorageKey, Options.Encode());
            if (!ghost) Session?.Forget();
        }

        // ------------------------------------------------------------------ the race

        /// <summary>Starts a race with the current setup (a new session when the setup changed). Null with <see cref="Problem"/> set.</summary>
        public OfflineRaceDriver StartRace(ulong? seed = null)
        {
            if (!CanStart) { Message = Available ? Problem : FtueLocked; return null; }
            if (Session == null) Session = new PracticeSession(Catalog, Setup, seed ?? PracticeSession.NextSeed((ulong)_now()), Options);
            else if (Session.Setup.Encode() != Setup.Encode()) Session.ChangeSetup(Setup);
            return Begin(Session.Start());
        }

        /// <summary>REQ-PRAC-006: 「同じ展開でもう一度」 / 「新しい相手で」, mid-race or from the result.</summary>
        public OfflineRaceDriver Restart(PracticeRestart mode)
        {
            if (Session == null) return StartRace();
            return Begin(Session.Restart(mode));
        }

        private OfflineRaceDriver Begin(OfflineRace race)
        {
            Observer?.Dispose();
            Driver = new OfflineRaceDriver(race);
            AssistModel.Attach(Driver, Assist);
            Observer = new RaceObserver(Driver);
            _finishSent = false;
            Message = null;
            _track?.Invoke(AnalyticsEvent.PracticeStart(_now(), Session.Config.Track.Id, Session.Config.Entrants.Count, Session.Setup.StrengthId, PracticeSession.RestartWire(Session.LastRestart)));
            return Driver;
        }

        /// <summary>§41: the whip input of the accessibility settings on the race input (tap / hold).</summary>
        public void ApplyAccessibility(RaceInput input) { if (input != null) input.WhipMode = B.Accessibility.WhipInput; }

        /// <summary>One frame: drives the race with the practice clock (0.5× in the last 400 m when chosen) and returns the overlay.</summary>
        public PracticeFrame Frame(long realMs)
        {
            var f = new PracticeFrame();
            if (Driver == null || Session == null) return f;
            Driver.Update(Session.RaceNow(realMs));
            Observer?.Update();
            f.Slow = Session.Clock.Slow;
            var w = Session.WhipWindow;
            if (w != null)
            {
                f.BandFromM = w.FromRemainingM; f.BandToM = w.ToRemainingM;
                var me = Driver.Sim.GetHorse(Driver.PlayerSlot);
                f.InBand = me.Departed && !me.Finished && w.Contains(RaceFeel.RemainingMm(Driver.Sim, me));
                f.BandColor = AccessibilityTokens.Color(B.Accessibility.ColorMode, AccessibilityTokens.WhipChance);
            }
            if (Session.Ghost != null)
            {
                f.GhostLabel = Loc.T("前回") + "  " + Session.GhostHorseName + "  " + HudModel.FormatTime(Session.GhostTimeMs);
                f.GhostGapM = Session.GhostGapM;
            }
            if (Driver.Done) SendFinish();
            return f;
        }

        /// <summary>Reduced motion (§41): the slow-motion switch and the band highlight are instant, never animated.</summary>
        public int TransitionMs(int normalMs) => MotionPolicy.For(B.Accessibility).Reduced ? 0 : normalMs;

        /// <summary>REQ-PRAC-012: photo mode pauses a practice race (a solo race) — PhotoModeModel.OpenPaused with this driver.</summary>
        public bool CanTakePhoto => Driver != null && (Driver.Done || PhotoModeModel.CanPause(Driver));

        private void SendFinish()
        {
            if (_finishSent || Session == null) return;
            _finishSent = true;
            _track?.Invoke(AnalyticsEvent.PracticeFinish(_now(), Session.Config.Track.Id, Session.Config.Entrants.Count, Session.Setup.StrengthId, Session.KpiPlace));
        }

        /// <summary>§50.5: the result screen (no reward field; the buttons never include saving or sharing a replay).</summary>
        public PracticeResultView Result()
        {
            if (Session?.Race == null || !Session.Race.IsFinished) return null;
            SendFinish();
            var r = Session.Result();
            var v = new PracticeResultView { Finished = r.Finished, Place = r.Place, Runners = r.Runners, Buttons = new List<string>(ResultButtons) };
            v.PlaceText = r.Finished ? Loc.T(r.Place.ToString(CultureInfo.InvariantCulture) + "着 / " + r.Runners.ToString(CultureInfo.InvariantCulture) + "頭") : Loc.T("完走ならず");
            v.TimeText = r.TimeMs >= 0 ? HudModel.FormatTime(r.TimeMs) : "";
            foreach (var l in r.Lines) v.Lines.Add(Loc.T(l));
            return v;
        }

        public static string ButtonText(string id)
        {
            switch (id)
            {
                case "same_seed": return Loc.T(ButtonSameSeed);
                case "new_seed": return Loc.T(ButtonNewSeed);
                case "change": return Loc.T(ButtonChange);
                case "photo": return Loc.T(ButtonPhoto);
                default: return id;
            }
        }
    }
}
