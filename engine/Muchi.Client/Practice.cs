using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // =====================================================================================================
    // 練習レース (practice races, REQ-PRAC-001..018, contracts/protocol.md §50).
    //
    // The player races CPU fields ON THE DEVICE with the real engine: any own horse, any course / going / night,
    // 2..12 runners, a CPU strength from the existing CPU definitions. PracticeSession builds the config (pure,
    // deterministic from catalog + setup + seed), runs it as an OfflineRace, restarts with the same or a new seed,
    // and keeps the previous finished attempt as a ghost (a separate GhostPlayer simulation that never touches the
    // live race). Nothing here talks to the server except the read-only catalog: practice grants nothing (no coins,
    // missions, pass XP, stats, rating, hall career, recap, rival or team goal) — there is no API to send it to.
    // =====================================================================================================

    /// <summary>A CPU strength (protocol §50.1): the CPU riding level and a CPU stat scale, from existing definitions.</summary>
    public sealed class PracticeStrength
    {
        public string Id, Name, Note;
        public int CpuLevel = 3, CpuStatPermille = 1000;
        public static PracticeStrength Parse(JsonNode o) => new PracticeStrength
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Note = J.Str(o, "note"), CpuLevel = J.Int(o, "cpuLevel", 3), CpuStatPermille = J.Int(o, "cpuStatPermille", 1000),
        };
        internal JsonNode ToJson() => JsonNode.Obj().Set("id", Id).Set("name", Name).Set("note", Note).Set("cpuLevel", CpuLevel).Set("cpuStatPermille", CpuStatPermille);
    }

    /// <summary>A course the player may practise on, with its goings, lights and today's ground.</summary>
    public sealed class PracticeCourse
    {
        public string TrackId, Name, Surface;
        public int DistanceM;
        public List<TrackSegment> Segments = new List<TrackSegment>();
        public bool Lights;
        public List<string> Goings = new List<string>();
        public string TodayGoing;
        public bool TodayNight;

        public static PracticeCourse Parse(JsonNode o)
        {
            var today = J.Opt(o, "today");
            var c = new PracticeCourse
            {
                TrackId = J.Str(o, "trackId"), Name = J.Str(o, "name"), Surface = J.Str(o, "surface"), DistanceM = J.Int(o, "distanceM"),
                Lights = J.Bool(o, "lights"), Goings = new List<string>(J.Strs(o, "goings")),
                TodayGoing = J.Str(today, "going"), TodayNight = J.Bool(today, "night"),
            };
            var segs = J.Opt(o, "segments");
            if (segs != null) c.Segments = ProtocolCodec.ParseSegments(segs);
            if (string.IsNullOrEmpty(c.TodayGoing)) c.TodayGoing = c.Surface == "dirt" ? "fast" : "good";
            return c;
        }

        /// <summary>The engine track with the chosen going and lighting.</summary>
        public TrackSpec Track(string going, bool night)
        {
            var surface = ProtocolCodec.ParseSurface(Surface, false);
            var t = new TrackSpec { Id = TrackId, Surface = surface, DistanceM = DistanceM, Going = ProtocolCodec.ParseGoing(going, surface), Night = night };
            foreach (var s in Segments) t.Segments.Add(new TrackSegment(s.Kind, s.LengthM, s.RadiusM));
            return t;
        }

        internal JsonNode ToJson()
        {
            var segs = JsonNode.Arr();
            foreach (var s in Segments)
            {
                var so = JsonNode.Obj().Set("kind", s.Kind == SegmentKind.Straight ? "straight" : "corner").Set("lengthM", s.LengthM);
                if (s.Kind == SegmentKind.Corner) so.Set("radiusM", s.RadiusM);
                segs.Add(so);
            }
            var gs = JsonNode.Arr();
            foreach (var g in Goings) gs.Add(JsonNode.Str(g));
            return JsonNode.Obj().Set("trackId", TrackId).Set("name", Name).Set("surface", Surface).Set("distanceM", DistanceM).Set("segments", segs)
                .Set("lights", Lights).Set("goings", gs).Set("today", JsonNode.Obj().Set("going", TodayGoing).Set("night", TodayNight));
        }
    }

    /// <summary>One of the player's own horses (race stats, capped skill) as the catalog lists it.</summary>
    public sealed class PracticeHorse
    {
        public HorseSpec Spec;
        public bool Partner;
        public string Id => Spec?.Id;
        public string Name => Spec?.Name;
    }

    /// <summary>GET /v1/practice/catalog (protocol §50.1), or the built-in fallback (§50.6).</summary>
    public sealed class PracticeCatalog
    {
        public const string StorageKey = "muchi.practice.catalog";
        public const string FallbackTrackId = "kirameki_turf_2000";

        public int V = 1;
        public bool Enabled = true;
        public string RulesetVersion;
        public int FieldMin = 2, FieldMax = 12, FieldDefault = 8;
        public List<PracticeStrength> Strengths = new List<PracticeStrength>();
        public string DefaultStrength = "normal";
        public List<PracticeCourse> Courses = new List<PracticeCourse>();
        public List<HorseSpec> CpuHorses = new List<HorseSpec>();
        public List<PracticeHorse> Horses = new List<PracticeHorse>();
        public RulesetParams Ruleset;
        public NetParams Net = new NetParams();
        /// <summary>True for the built-in fallback (no catalog was ever received on this device).</summary>
        public bool IsFallback;
        /// <summary>The JSON as received (what the device stores under <see cref="StorageKey"/>); null for the fallback.</summary>
        public string Raw;

        public static PracticeCatalog FromJson(string json) => Parse(JsonNode.Parse(json), json);

        public static PracticeCatalog Parse(JsonNode o, string raw = null)
        {
            var f = J.Opt(o, "fieldSize");
            var c = new PracticeCatalog
            {
                V = J.Int(o, "v", 1), Enabled = J.Bool(o, "enabled", true), RulesetVersion = J.Str(o, "rulesetVersion"),
                FieldMin = J.Int(f, "min", 2), FieldMax = J.Int(f, "max", 12), FieldDefault = J.Int(f, "default", 8),
                Strengths = J.List(o, "strengths", PracticeStrength.Parse), DefaultStrength = J.Str(o, "defaultStrength") ?? "normal",
                Courses = J.List(o, "courses", PracticeCourse.Parse),
                CpuHorses = J.List(o, "cpuHorses", ProtocolCodec.ParseHorse),
                Horses = J.List(o, "horses", h => new PracticeHorse { Spec = ProtocolCodec.ParseHorse(h), Partner = J.Bool(h, "partner") }),
                Raw = raw ?? o.ToString(),
            };
            var rs = J.Opt(o, "ruleset");
            if (rs != null) c.Ruleset = ProtocolCodec.ParseRuleset(rs);
            var n = J.Opt(o, "net");
            if (n != null) c.Net = new NetParams
            {
                TickHz = J.Int(n, "tickHz", 20), InputDelayTicks = J.Int(n, "inputDelayTicks", 3), BundleIntervalTicks = J.Int(n, "bundleIntervalTicks", 2),
                ChecksumIntervalTicks = J.Int(n, "checksumIntervalTicks", 20), DisconnectGraceMs = J.Int(n, "disconnectGraceMs", 3000),
            };
            return c;
        }

        /// <summary>The strengths every catalog has (protocol §50.1; the server resolves the same numbers from its definitions).</summary>
        public static List<PracticeStrength> DefaultStrengths() => new List<PracticeStrength>
        {
            new PracticeStrength { Id = "easy", Name = "やさしい", Note = "初心者マッチと同じ相手", CpuLevel = 1, CpuStatPermille = 780 },
            new PracticeStrength { Id = "normal", Name = "ふつう", Note = "ランク戦（レート1400〜1600）の相手", CpuLevel = 3, CpuStatPermille = 1000 },
            new PracticeStrength { Id = "strong", Name = "つよい", Note = "ランク戦（レート1600〜1800）の相手", CpuLevel = 4, CpuStatPermille = 1000 },
            new PracticeStrength { Id = "top", Name = "いちばん強い", Note = "ランク戦（レート1800以上）の相手", CpuLevel = 5, CpuStatPermille = 1000 },
        };

        private static readonly string[] FallbackCpuNames =
        {
            "ハヤテノツバサ", "ユウヤケボシ", "アオゾラマーチ", "シラカバノオカ", "ナミノリタロウ", "ツキミダンゴ",
            "ホシクズノミチ", "コハルビヨリ", "カゼマチリボン", "ミナモノヒカリ", "サクラフブキ",
        };

        /// <summary>
        /// §50.6: the built-in catalog for a device that never received one (offline since the first launch): the practice
        /// course (turf 2000 m), the four strengths, 11 built-in CPUs, the given partner (or none: the caller adds its
        /// default partner) and the app's bundled ruleset.
        /// </summary>
        public static PracticeCatalog Fallback(RulesetParams ruleset, HorseSpec partner = null)
        {
            if (ruleset == null) throw new ArgumentNullException(nameof(ruleset));
            var c = new PracticeCatalog { IsFallback = true, Ruleset = ruleset, RulesetVersion = ruleset.RulesetVersion, Strengths = DefaultStrengths() };
            var course = new PracticeCourse
            {
                TrackId = FallbackTrackId, Name = "きらめき競馬場 芝2000m", Surface = "turf", DistanceM = 2000, Lights = false,
                Goings = new List<string> { "firm", "good", "yielding", "soft" }, TodayGoing = "good", TodayNight = false,
            };
            course.Segments.Add(new TrackSegment(SegmentKind.Straight, 300));
            course.Segments.Add(new TrackSegment(SegmentKind.Corner, 300, 110));
            course.Segments.Add(new TrackSegment(SegmentKind.Straight, 450));
            course.Segments.Add(new TrackSegment(SegmentKind.Corner, 450, 110));
            course.Segments.Add(new TrackSegment(SegmentKind.Straight, 500));
            c.Courses.Add(course);
            for (int i = 0; i < FallbackCpuNames.Length; i++)
            {
                int Stat(int k) => 470 + ((i * 37 + k * 53) % 120);
                c.CpuHorses.Add(new HorseSpec
                {
                    Id = "cpu_builtin_" + (i + 1), Name = FallbackCpuNames[i], Speed = Stat(1), Stamina = Stat(2), Burst = Stat(3), Guts = Stat(4), Temper = Stat(5),
                    Style = (RunningStyle)(i % 4), DistMinM = 1600, DistMaxM = 2400, Surface = Surface.Turf,
                });
            }
            if (partner != null) c.Horses.Add(new PracticeHorse { Spec = partner, Partner = true });
            return c;
        }

        public PracticeCourse Course(string trackId) => Courses.Find(x => x.TrackId == trackId);
        public PracticeStrength Strength(string id) => Strengths.Find(x => x.Id == id);
        public PracticeHorse Horse(string id) => Horses.Find(x => x.Id == id);

        /// <summary>Largest field this catalog can build: the configured max, the engine's lanes and the CPU pool + me.</summary>
        public int MaxField => Math.Min(FieldMax, Math.Min(Ruleset?.LaneCount ?? 12, CpuHorses.Count + 1));
    }

    /// <summary>What the player chose on the practice setup screen.</summary>
    public sealed class PracticeSetup
    {
        public string HorseId, TrackId, Going, StrengthId;
        public bool Night;
        public int FieldSize = 8;

        public PracticeSetup Clone() => (PracticeSetup)MemberwiseClone();

        /// <summary>The screen's first choice: the partner (else the first horse), the practice course when listed, today's ground, the default field and strength.</summary>
        public static PracticeSetup Default(PracticeCatalog c)
        {
            if (c == null) throw new ArgumentNullException(nameof(c));
            var horse = c.Horses.Find(h => h.Partner) ?? (c.Horses.Count > 0 ? c.Horses[0] : null);
            var course = c.Course(PracticeCatalog.FallbackTrackId) ?? (c.Courses.Count > 0 ? c.Courses[0] : null);
            return new PracticeSetup
            {
                HorseId = horse?.Id, TrackId = course?.TrackId, Going = course?.TodayGoing, Night = course != null && course.Lights && course.TodayNight,
                FieldSize = Math.Max(c.FieldMin, Math.Min(c.FieldDefault, c.MaxField)), StrengthId = c.Strength(c.DefaultStrength) != null ? c.DefaultStrength : c.Strengths.Count > 0 ? c.Strengths[0].Id : null,
            };
        }

        /// <summary>Why this setup cannot be raced (Japanese; Loc.T for English), or null when it can.</summary>
        public string Problem(PracticeCatalog c)
        {
            if (c == null || c.Ruleset == null) return PracticeTexts.NoCatalog;
            if (c.Horse(HorseId) == null) return PracticeTexts.PickHorse;
            var course = c.Course(TrackId);
            if (course == null) return PracticeTexts.PickCourse;
            if (string.IsNullOrEmpty(Going) || !course.Goings.Contains(Going)) return PracticeTexts.GoingMismatch;
            if (Night && !course.Lights) return PracticeTexts.NightNeedsLights;
            if (FieldSize < c.FieldMin || FieldSize > c.MaxField) return PracticeTexts.Field(c.FieldMin, c.MaxField);
            if (c.Strength(StrengthId) == null) return PracticeTexts.PickStrength;
            return null;
        }

        public string Encode() => string.Join("|", HorseId ?? "", TrackId ?? "", Going ?? "", Night ? "1" : "0", FieldSize.ToString(CultureInfo.InvariantCulture), StrengthId ?? "");

        /// <summary>The setup the device remembered; null when it is unreadable (the caller falls back to <see cref="Default"/>).</summary>
        public static PracticeSetup Decode(string s)
        {
            if (string.IsNullOrEmpty(s)) return null;
            var p = s.Split('|');
            if (p.Length != 6 || !int.TryParse(p[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out var n)) return null;
            return new PracticeSetup { HorseId = p[0], TrackId = p[1], Going = p[2], Night = p[3] == "1", FieldSize = n, StrengthId = p[5] };
        }
    }

    /// <summary>The practice screen's options (§50.4), kept on the device.</summary>
    public sealed class PracticeOptions
    {
        public const string StorageKey = "muchi.practice.options";
        public bool WhipWindow = true;
        public bool SlowFinal;
        public bool Ghost = true;

        public string Encode() => (WhipWindow ? "w1" : "w0") + (SlowFinal ? "s1" : "s0") + (Ghost ? "g1" : "g0");
        public static PracticeOptions Decode(string s)
        {
            var o = new PracticeOptions();
            if (string.IsNullOrEmpty(s)) return o;
            if (s.Contains("w0")) o.WhipWindow = false;
            if (s.Contains("s1")) o.SlowFinal = true;
            if (s.Contains("g0")) o.Ghost = false;
            return o;
        }
    }

    public enum PracticeRestart { None, SameSeed, NewSeed }

    /// <summary>
    /// §50.4 slow motion: maps the real clock to the race clock. While <c>slow</c>, time runs at 0.5×. Only the clock the
    /// OfflineRace is driven with changes: the engine still steps 20 Hz ticks and inputs land on ticks, so the same inputs
    /// give the same result.
    /// </summary>
    public sealed class PracticeClock
    {
        public const int SlowFromM = 400;
        public const int SlowPermille = 500;
        private long _lastReal = long.MinValue;
        private long _virtUs;

        public bool Slow { get; private set; }

        public void Reset() { _lastReal = long.MinValue; _virtUs = 0; Slow = false; }

        public long Now(long realMs, bool slow)
        {
            if (_lastReal == long.MinValue) { _lastReal = realMs; _virtUs = realMs * 1000; Slow = slow; return realMs; }
            long dt = Math.Max(0, realMs - _lastReal);
            _lastReal = realMs;
            _virtUs += dt * (Slow ? SlowPermille : 1000);
            Slow = slow; // the new rate applies from this frame on (an instant switch; nothing to animate)
            return _virtUs / 1000;
        }

        /// <summary>The player's horse is running its last 400 m.</summary>
        public static bool InSlowZone(RaceSim sim, int slot)
        {
            if (sim == null || slot < 0 || slot >= sim.EntrantCount) return false;
            var h = sim.GetHorse(slot);
            return h.Departed && !h.Finished && RaceFeel.RemainingMm(sim, h) <= SlowFromM * 1000L;
        }
    }

    /// <summary>§50.4 the whip band: the range RaceAdvice.CheckWhipTip counts as following the tip.</summary>
    public sealed class PracticeWhipWindow
    {
        public int StartRemainingM, FromRemainingM, ToRemainingM;
        public static PracticeWhipWindow From(AdviceWhipTip tip) => tip == null ? null : new PracticeWhipWindow
        {
            StartRemainingM = tip.StartRemainingM,
            FromRemainingM = tip.StartRemainingM + RaceAdvice.WhipEarlyToleranceM,
            ToRemainingM = Math.Max(0, tip.StartRemainingM - RaceAdvice.WhipLateToleranceM),
        };
        public bool Contains(long remainingMm) => remainingMm <= FromRemainingM * 1000L && remainingMm >= ToRemainingM * 1000L;
    }

    /// <summary>The result screen of a practice run (§50.5). There is no reward field: practice grants nothing.</summary>
    public sealed class PracticeResult
    {
        public bool Finished;
        /// <summary>1-based place, 0 when the horse did not finish.</summary>
        public int Place, Runners;
        public long TimeMs = -1;
        public RaceDebrief Debrief;
        public WhipTipVerdict? AdviceVerdict;
        public string AdviceLine;
        public long? GhostTimeMs, DeltaMs;
        public string GhostLine;
        public string ResultHash;
        public readonly string NoRewardLine = PracticeTexts.NoReward;

        /// <summary>The result screen's lines in order (Japanese; Loc.T gives English).</summary>
        public List<string> Lines
        {
            get
            {
                var o = new List<string>();
                if (!string.IsNullOrEmpty(Debrief?.Line)) o.Add(Debrief.Line);
                if (!string.IsNullOrEmpty(Debrief?.Tip)) o.Add(Debrief.Tip);
                if (!string.IsNullOrEmpty(AdviceLine)) o.Add(AdviceLine);
                if (!string.IsNullOrEmpty(GhostLine)) o.Add(GhostLine);
                o.Add(NoRewardLine);
                return o;
            }
        }
    }

    /// <summary>Practice texts (Japanese; ui-en.json has the English).</summary>
    public static class PracticeTexts
    {
        public const string Title = "練習レース";
        public const string ModeLabel = "練習レース";
        public const string NoReward = "報酬はありません（練習）";
        public const string NoCatalog = "練習の準備ができていません";
        public const string PickHorse = "馬を選んでください";
        public const string PickCourse = "このコースは選べません";
        public const string GoingMismatch = "この馬場はこのコースにありません";
        public const string NightNeedsLights = "ナイターは照明のある競馬場だけです";
        public const string FieldRange = "頭数は{n}〜{m}頭です";
        public static string Field(int min, int max) => FieldRange.Replace("{n}", min.ToString(CultureInfo.InvariantCulture)).Replace("{m}", max.ToString(CultureInfo.InvariantCulture));
        public const string PickStrength = "強さを選んでください";
        public const string GhostFaster = "前回より{n}秒速い";
        public const string GhostSlower = "前回より{n}秒遅い";
        public const string GhostSame = "前回と同じタイム";
        public const string WhipBand = "ムチの目安";

        public static string GhostDelta(long deltaMs)
        {
            if (deltaMs == 0) return GhostSame;
            string s = (Math.Abs(deltaMs) / 1000.0).ToString("0.00", CultureInfo.InvariantCulture);
            return (deltaMs < 0 ? GhostFaster : GhostSlower).Replace("{n}", s);
        }
    }

    /// <summary>One practice session: the setup, the current attempt, restarts and the ghost of the previous attempt.</summary>
    public sealed class PracticeSession
    {
        /// <summary>PCG32 stream for the CPU pick and the gate draw ("PRAC").</summary>
        public const ulong RngStream = 0x50524143;
        public const string RaceIdPrefix = "practice_";
        public const string LegacyRaceId = "offline_practice";
        /// <summary>REQ-PRAC-011: practice never grants anything (documentation constant; nothing here could).</summary>
        public const bool GrantsRewards = false;

        private ReplayLog _prevLog;
        private int _prevSlot;
        private string _prevHorse, _prevTrack;
        private long _prevTimeMs = -1;

        public PracticeCatalog Catalog { get; }
        public PracticeSetup Setup { get; private set; }
        public PracticeOptions Options { get; }
        public ulong Seed { get; private set; }
        public RaceConfig Config { get; private set; }
        public int PlayerSlot { get; private set; }
        public OfflineRace Race { get; private set; }
        /// <summary>Races started in this session (1 for the first).</summary>
        public int Attempt { get; private set; }
        public PracticeRestart LastRestart { get; private set; } = PracticeRestart.None;
        public GhostPlayer Ghost { get; private set; }
        public string GhostHorseName => Ghost == null ? null : _prevHorse;
        public long GhostTimeMs => Ghost == null ? -1 : _prevTimeMs;
        public bool HasPreviousRun => _prevLog != null;
        /// <summary>The pre-race advice for this race (§39, computed on the device for the practice setup).</summary>
        public RaceAdviceResult Advice { get; private set; }
        public PracticeClock Clock { get; } = new PracticeClock();

        public PracticeSession(PracticeCatalog catalog, PracticeSetup setup, ulong seed, PracticeOptions options = null)
        {
            Catalog = catalog ?? throw new ArgumentNullException(nameof(catalog));
            Options = options ?? new PracticeOptions();
            var p = setup?.Problem(catalog);
            if (setup == null || p != null) throw new ArgumentException(p ?? PracticeTexts.PickHorse);
            Setup = setup.Clone();
            Seed = seed;
            Build();
        }

        public static bool IsPractice(RaceConfig c) => c != null && c.RaceId != null && (c.RaceId.StartsWith(RaceIdPrefix, StringComparison.Ordinal) || c.RaceId == LegacyRaceId);

        /// <summary>The next seed of 「新しい相手で」 (no clock: the same session restarts the same way).</summary>
        public static ulong NextSeed(ulong seed) { var s = SeedMix.Mix(seed + 0x9E3779B97F4A7C15UL); return s == 0 ? 1 : s; }

        /// <summary>The whip band for this race (null when the option is off or the advice has no whip tip).</summary>
        public PracticeWhipWindow WhipWindow => Options.WhipWindow ? PracticeWhipWindow.From(Advice?.Whip) : null;

        /// <summary>REQ-PRAC-005: the race for (catalog, setup, seed) — pure: the same input always gives the same config.</summary>
        public static RaceConfig BuildConfig(PracticeCatalog c, PracticeSetup s, ulong seed)
        {
            var problem = s?.Problem(c);
            if (s == null || problem != null) throw new ArgumentException(problem ?? PracticeTexts.PickHorse);
            var me = Clone(c.Horse(s.HorseId).Spec, 1000);
            var course = c.Course(s.TrackId);
            var strength = c.Strength(s.StrengthId);
            var rng = new Pcg32(seed, RngStream);
            var pool = new List<HorseSpec>();
            foreach (var h in c.CpuHorses) if (h.Name != me.Name) pool.Add(h);
            if (pool.Count < s.FieldSize - 1) throw new ArgumentException(PracticeTexts.Field(c.FieldMin, pool.Count + 1));
            var entrants = new List<Entrant> { new Entrant { Kind = EntrantKind.Human, PlayerId = "local", CpuLevel = 3, Horse = me } };
            for (int i = 0; i < s.FieldSize - 1; i++)
            {
                int k = rng.NextInt(pool.Count);
                entrants.Add(new Entrant { Kind = EntrantKind.Cpu, CpuLevel = strength.CpuLevel, Horse = Clone(pool[k], strength.CpuStatPermille) });
                pool.RemoveAt(k);
            }
            for (int i = entrants.Count - 1; i > 0; i--) // the gate draw (Fisher–Yates), like buildRaceConfig
            {
                int j = rng.NextInt(i + 1);
                var t = entrants[i]; entrants[i] = entrants[j]; entrants[j] = t;
            }
            var cfg = new RaceConfig
            {
                RaceId = RaceIdPrefix + seed.ToString("x16", CultureInfo.InvariantCulture), Mode = RaceMode.Friend, Seed = seed,
                Track = course.Track(s.Going, s.Night), Ruleset = c.Ruleset,
                Net = new NetParams { TickHz = c.Net.TickHz, InputDelayTicks = c.Net.InputDelayTicks, BundleIntervalTicks = c.Net.BundleIntervalTicks, ChecksumIntervalTicks = c.Net.ChecksumIntervalTicks, DisconnectGraceMs = c.Net.DisconnectGraceMs },
            };
            for (int i = 0; i < entrants.Count; i++) { entrants[i].Slot = i; cfg.Entrants.Add(entrants[i]); }
            cfg.Validate();
            return cfg;
        }

        private static HorseSpec Clone(HorseSpec h, int statPermille)
        {
            int S(int v) => statPermille == 1000 ? v : (int)((long)v * statPermille / 1000);
            return new HorseSpec
            {
                Id = h.Id, Name = h.Name, Speed = S(h.Speed), Stamina = S(h.Stamina), Burst = S(h.Burst), Guts = S(h.Guts), Temper = S(h.Temper),
                Style = h.Style, DistMinM = h.DistMinM, DistMaxM = h.DistMaxM, Surface = h.Surface, GoingAptitude = h.GoingAptitude, Skill = h.Skill,
            };
        }

        public static int SlotOfPlayer(RaceConfig cfg)
        {
            foreach (var e in cfg.Entrants) if (e.Kind == EntrantKind.Human) return e.Slot;
            return 0;
        }

        private void Build()
        {
            Config = BuildConfig(Catalog, Setup, Seed);
            PlayerSlot = SlotOfPlayer(Config);
            Advice = AdviceFor(Config, PlayerSlot, Setup);
            Race = null;
            Ghost = null;
        }

        /// <summary>§50.5: the advice for the practice setup (friend-room rules, one course, the field's styles are known).</summary>
        public static RaceAdviceResult AdviceFor(RaceConfig cfg, int slot, PracticeSetup s)
        {
            var me = cfg.Entrants[slot].Horse;
            var styles = new List<string>();
            foreach (var e in cfg.Entrants) if (e.Slot != slot) styles.Add(ProtocolCodec.StyleToString(e.Horse.Style));
            var input = new AdviceInput
            {
                Mode = "friend", Rules = RaceAdvice.Rules(cfg.Ruleset), Field = AdviceField.From(styles, 0), FocusHorseId = me.Id,
            };
            input.Courses.Add(RaceAdvice.Course(cfg.Track, s.Going, s.Night));
            input.Horses.Add(new AdviceHorse
            {
                Id = me.Id, Name = me.Name, Style = ProtocolCodec.StyleToString(me.Style), DistMinM = me.DistMinM, DistMaxM = me.DistMaxM,
                Surface = ProtocolCodec.SurfaceToString(me.Surface), GoingAptitude = me.GoingAptitude.HasValue ? ProtocolCodec.GoingAptitudeToString(me.GoingAptitude.Value) : "any",
                Speed = me.Speed, Stamina = me.Stamina, Burst = me.Burst, Guts = me.Guts, Temper = me.Temper,
                Skill = me.Skill == null ? null : new AdviceSkill { Id = me.Skill.Id, Name = me.Skill.Name, Trigger = ProtocolCodec.SkillTriggerToString(me.Skill.Trigger) },
            });
            return RaceAdvice.Compute(input);
        }

        /// <summary>Starts the current attempt (with the ghost of the previous finished attempt on the same course, when on).</summary>
        public OfflineRace Start()
        {
            Remember();
            Race = new OfflineRace(Config, PlayerSlot);
            Attempt++;
            Clock.Reset();
            Ghost = null;
            if (Options.Ghost && _prevLog != null && _prevTrack == Config.Track.Id)
                Ghost = new GhostPlayer(_prevLog, new GhostMeta { HorseName = _prevHorse, TrackId = _prevTrack, TimeMs = _prevTimeMs }, _prevSlot);
            var race = Race;
            race.Stepped += r => { if (r == Race) Ghost?.AdvanceTo(r.Sim.Tick - 1); };
            return Race;
        }

        /// <summary>REQ-PRAC-006: 「同じ展開でもう一度」 (same seed) / 「新しい相手で」 (next seed). Any time, no confirmation.</summary>
        public OfflineRace Restart(PracticeRestart mode)
        {
            Remember();
            if (mode == PracticeRestart.NewSeed) Seed = NextSeed(Seed);
            Build();
            LastRestart = mode == PracticeRestart.None ? PracticeRestart.SameSeed : mode;
            return Start();
        }

        /// <summary>「条件を変える」: a new setup (same seed). The ghost stays unless the course changed.</summary>
        public void ChangeSetup(PracticeSetup setup)
        {
            var p = setup?.Problem(Catalog);
            if (setup == null || p != null) throw new ArgumentException(p ?? PracticeTexts.PickHorse);
            Remember();
            Setup = setup.Clone();
            if (_prevTrack != Setup.TrackId) Forget();
            Build();
            LastRestart = PracticeRestart.None;
        }

        /// <summary>Drops the ghost of the previous attempt (option off, or the course changed).</summary>
        public void Forget() { _prevLog = null; _prevHorse = null; _prevTrack = null; _prevTimeMs = -1; Ghost = null; }

        /// <summary>Keeps the current attempt as the next ghost when the player's horse reached the line.</summary>
        private void Remember()
        {
            var r = Race;
            if (r == null || !r.IsFinished) return;
            var me = r.Sim.GetHorse(PlayerSlot);
            if (!me.Finished) return;
            _prevLog = new ReplayLog { Config = r.Config, EndTick = -1, Inputs = new List<InputRecord>(r.RecordedInputs) };
            _prevSlot = PlayerSlot;
            _prevHorse = r.Config.Entrants[PlayerSlot].Horse.Name;
            _prevTrack = r.Config.Track.Id;
            _prevTimeMs = r.FinishTimeMs(PlayerSlot);
            Race = null; // remembered once
        }

        /// <summary>The race clock for this frame (§50.4: 0.5× in the last 400 m when the option is on).</summary>
        public long RaceNow(long realMs) => Clock.Now(realMs, Options.SlowFinal && Race != null && PracticeClock.InSlowZone(Race.Sim, PlayerSlot));

        /// <summary>Ghost distance minus mine, metres (positive = the ghost is ahead); null without a ghost.</summary>
        public double? GhostGapM
        {
            get
            {
                if (Ghost == null || Race == null) return null;
                return (Ghost.Horse.Distance - Race.Sim.GetHorse(PlayerSlot).Distance).Raw / (double)Fx.OneRaw;
            }
        }

        /// <summary>§50.5: the result screen of the finished attempt (the debrief, the advice check, the ghost delta, no reward).</summary>
        public PracticeResult Result()
        {
            var r = Race ?? throw new InvalidOperationException("no race to finish");
            if (!r.IsFinished) throw new InvalidOperationException("the race is still running");
            var res = r.Sim.Result;
            var me = r.Sim.GetHorse(PlayerSlot);
            var o = new PracticeResult { Runners = Config.Entrants.Count, Finished = me.Finished, ResultHash = res.Hash };
            if (me.Finished) { o.Place = Array.IndexOf(res.Order, PlayerSlot) + 1; o.TimeMs = r.FinishTimeMs(PlayerSlot); }
            o.Debrief = RaceDebrief.FromInputs(Config, new List<InputRecord>(r.RecordedInputs), PlayerSlot);
            if (Options.WhipWindow && Advice?.Whip != null)
            {
                var v = RaceAdvice.CheckWhipTip(Advice.Whip, o.Debrief.Facts);
                o.AdviceVerdict = v;
                o.AdviceLine = RaceAdvice.WhipTipText(v, Advice.Whip);
            }
            if (Ghost != null && _prevTimeMs >= 0 && o.TimeMs >= 0)
            {
                o.GhostTimeMs = _prevTimeMs;
                o.DeltaMs = o.TimeMs - _prevTimeMs;
                o.GhostLine = PracticeTexts.GhostDelta(o.DeltaMs.Value);
            }
            return o;
        }

        /// <summary>KPI place (0 = did not finish).</summary>
        public int KpiPlace => Race != null && Race.IsFinished && Race.Sim.GetHorse(PlayerSlot).Finished ? Array.IndexOf(Race.Sim.Result.Order, PlayerSlot) + 1 : 0;

        public static string RestartWire(PracticeRestart r) => r == PracticeRestart.SameSeed ? "same_seed" : r == PracticeRestart.NewSeed ? "new_seed" : "none";
    }

    public sealed partial class ApiClient
    {
        // ------------------------------------------------------------------ 練習レース (REQ-PRAC-002)

        /// <summary>GET /v1/practice/catalog (read-only; store <see cref="PracticeCatalog.Raw"/> for offline use).</summary>
        public Task<PracticeCatalog> GetPracticeCatalogAsync(CancellationToken ct = default)
            => Call("GET", "/v1/practice/catalog", null, true, null, true, o => PracticeCatalog.Parse(o), ct);
    }
}
