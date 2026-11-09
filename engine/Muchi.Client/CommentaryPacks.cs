using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // 実況パック (commentary packs, REQ-CMT-001..014, contracts/protocol.md §36, server/src/domain/commentaryPacks.ts).
    // A pack lays its own wording over the standard templates (commentary-ja.json / commentary-en.json) per phrase key.
    // Commentary is produced on the device only: a pack never changes a race, its hash, its replay or its result.

    /// <summary>One pack of Resources/Muchi/commentary-packs.json (the copy of server/master/commentary-packs.json).</summary>
    public sealed class CommentaryPackDef
    {
        public string Id, Name, Description;
        public int Order;
        /// <summary>default | achievement | coins.</summary>
        public string AcquireKind;
        public int Price;
        public string Currency;
        public string AchievementId;
        public int AchievementTier;
        /// <summary>Standard base kinds this pack speaks with the standard lines: exact kinds or "prefix*".</summary>
        public List<string> Fallback = new List<string>();
        /// <summary>Language ("ja" / "en") → phrase key → variants. English is optional (missing kinds use the standard English).</summary>
        public readonly Dictionary<string, Dictionary<string, List<PhraseVariant>>> Phrases = new Dictionary<string, Dictionary<string, List<PhraseVariant>>>();

        public bool IsStandard => Id == CommentaryPackCatalog.StandardPackId;
        /// <summary>The pack has its own English lines (otherwise English speaks the standard English).</summary>
        public bool HasEnglish => Phrases.TryGetValue(Loc.En, out var en) && en.Count > 0;

        public bool CoveredByFallback(string kind)
        {
            foreach (var f in Fallback)
                if (f.EndsWith("*", StringComparison.Ordinal) ? kind.StartsWith(f.Substring(0, f.Length - 1), StringComparison.Ordinal) : f == kind) return true;
            return false;
        }
    }

    /// <summary>The stock race of the 10-second sample (REQ-CMT-008): a fixed course, seed and CPU field.</summary>
    public sealed class CommentarySampleSpec
    {
        public ulong Seed;
        public int Seconds = 10;
        public TrackSpec Track;
        public List<HorseSpec> Horses = new List<HorseSpec>();
    }

    public sealed class CommentaryPackCatalog
    {
        public const string StandardPackId = "standard";
        public int Version;
        public CommentarySampleSpec Sample;
        public readonly List<CommentaryPackDef> Packs = new List<CommentaryPackDef>();

        public CommentaryPackDef Find(string id) => Packs.Find(p => p.Id == id);

        /// <summary>Parses commentary-packs.json (in Unity: the TextAsset Resources/Muchi/commentary-packs).</summary>
        public static CommentaryPackCatalog Parse(string json)
        {
            var o = JsonNode.Parse(json);
            var c = new CommentaryPackCatalog { Version = J.Int(o, "version", 1) };
            foreach (var p in J.List(o, "packs", x => x))
            {
                var a = J.Opt(p, "acquire");
                var d = new CommentaryPackDef
                {
                    Id = J.Str(p, "id"), Name = J.Str(p, "name"), Description = J.Str(p, "description"), Order = J.Int(p, "order"),
                    AcquireKind = J.Str(a, "kind") ?? "default", Price = J.Int(a, "price"), Currency = J.Str(a, "currency"),
                    AchievementId = J.Str(a, "achievementId"), AchievementTier = J.Int(a, "tier"),
                };
                d.Fallback.AddRange(J.Strs(p, "fallback") ?? new string[0]);
                var ph = J.Opt(p, "phrases");
                if (ph != null)
                    foreach (var lang in ph.Props)
                    {
                        var byKey = new Dictionary<string, List<PhraseVariant>>();
                        foreach (var kv in lang.Value.Props)
                        {
                            var list = new List<PhraseVariant>();
                            foreach (var v in kv.Value.Get("variants").Items) list.Add(new PhraseVariant { Id = J.Str(v, "id"), Text = J.Str(v, "text") });
                            byKey[kv.Key] = list;
                        }
                        d.Phrases[Loc.Normalize(lang.Key)] = byKey;
                    }
                c.Packs.Add(d);
            }
            c.Packs.Sort((x, y) => x.Order.CompareTo(y.Order));
            var s = J.Opt(o, "sample");
            if (s != null)
            {
                var spec = new CommentarySampleSpec { Seed = (ulong)J.Long(s, "seed"), Seconds = J.Int(s, "seconds", 10) };
                var t = J.Opt(s, "track");
                spec.Track = new TrackSpec { Id = J.Str(t, "id"), Surface = J.Str(t, "surface") == "dirt" ? Surface.Dirt : Surface.Turf, DistanceM = J.Int(t, "distanceM") };
                foreach (var seg in J.List(t, "segments", x => x))
                    spec.Track.Segments.Add(J.Str(seg, "kind") == "corner" ? new TrackSegment(SegmentKind.Corner, J.Int(seg, "lengthM"), J.Int(seg, "radiusM")) : new TrackSegment(SegmentKind.Straight, J.Int(seg, "lengthM")));
                foreach (var e in J.List(s, "entrants", x => x))
                {
                    var st = J.Opt(e, "stats");
                    spec.Horses.Add(new HorseSpec
                    {
                        Id = J.Str(e, "templateId"), Name = J.Str(e, "name"),
                        Speed = J.Int(st, "speed"), Stamina = J.Int(st, "stamina"), Burst = J.Int(st, "burst"), Guts = J.Int(st, "guts"), Temper = J.Int(st, "temper"),
                        Style = StyleOf(J.Str(e, "style")), DistMinM = J.Int(e, "distMinM"), DistMaxM = J.Int(e, "distMaxM"),
                        Surface = J.Str(e, "surface") == "dirt" ? Surface.Dirt : J.Str(e, "surface") == "both" ? Surface.Both : Surface.Turf,
                    });
                }
                c.Sample = spec;
            }
            return c;
        }

        private static RunningStyle StyleOf(string s) => s == "nige" ? RunningStyle.Nige : s == "senko" ? RunningStyle.Senko : s == "oikomi" ? RunningStyle.Oikomi : RunningStyle.Sashi;

        /// <summary>
        /// REQ-CMT-002: the templates of <paramref name="standard"/> with the pack laid over them (in the standard's language).
        /// Every key the pack has replaces the standard's variants (priority and mustSay stay the standard's); replacing a base
        /// kind drops the standard's specialisations of that kind unless the pack has its own. The standard pack (or null)
        /// returns <paramref name="standard"/> itself. Throws FormatException when the pack fails <see cref="CommentaryPackLint"/>.
        /// </summary>
        public static CommentaryTemplates Apply(CommentaryTemplates standard, CommentaryPackDef pack)
        {
            if (standard == null) throw new ArgumentNullException(nameof(standard));
            if (standard.Standard != null) standard = standard.Standard;
            if (pack == null || pack.IsStandard) return standard;
            var problems = CommentaryPackLint.Problems(standard, pack);
            if (problems.Count > 0) throw new FormatException("commentary pack " + pack.Id + ": " + string.Join("; ", problems));
            var t = new CommentaryTemplates
            {
                Language = standard.Language, TicksPerChar = standard.TicksPerChar, MinLineTicks = standard.MinLineTicks, GapTicks = standard.GapTicks,
                LeaderStableTicks = standard.LeaderStableTicks, PositionCallIntervalTicks = standard.PositionCallIntervalTicks, PendingExpiryTicks = standard.PendingExpiryTicks,
                MustSayExpiryTicks = standard.MustSayExpiryTicks, PhotoFinishTicks = standard.PhotoFinishTicks, DuelWindowTicks = standard.DuelWindowTicks,
                ComebackFromRank = standard.ComebackFromRank, MaxOtherSkillLines = standard.MaxOtherSkillLines,
                PackId = pack.Id, Standard = standard,
            };
            pack.Phrases.TryGetValue(standard.Language, out var over);
            over = over ?? new Dictionary<string, List<PhraseVariant>>();
            foreach (var kv in standard.Phrases)
            {
                int at = kv.Key.IndexOf('@');
                // a specialisation of a kind the pack replaced, which the pack does not specialise itself: the pack's voice wins
                if (at > 0 && over.ContainsKey(kv.Key.Substring(0, at)) && !over.ContainsKey(kv.Key)) continue;
                if (!over.TryGetValue(kv.Key, out var variants)) { t.Phrases[kv.Key] = kv.Value; continue; }
                t.Phrases[kv.Key] = Overlay(kv.Value, variants);
            }
            foreach (var kv in over)
            {
                if (t.Phrases.ContainsKey(kv.Key)) continue;
                // a pack specialisation the standard does not have: it inherits its base kind's rules
                int at = kv.Key.IndexOf('@');
                var b = at > 0 && standard.Phrases.TryGetValue(kv.Key.Substring(0, at), out var bd) ? bd : null;
                if (b != null) t.Phrases[kv.Key] = Overlay(b, kv.Value, kv.Key);
            }
            return t;
        }

        private static PhraseDef Overlay(PhraseDef std, List<PhraseVariant> variants, string kind = null)
        {
            var d = new PhraseDef { Kind = kind ?? std.Kind, Priority = std.Priority, MustSay = std.MustSay };
            foreach (var v in variants)
            {
                var pv = new PhraseVariant { Id = v.Id, Text = v.Text };
                pv.Parts = CommentaryTemplates.SplitParts(pv.Id, pv.Text);
                d.Variants.Add(pv);
            }
            return d;
        }
    }

    /// <summary>
    /// REQ-CMT-005 (client side, at load): explicit fallback and placeholders against the standard templates. The server
    /// runs the same rules in its tests, plus the wording / betting / real-name lint at boot.
    /// </summary>
    public static class CommentaryPackLint
    {
        private static readonly string[] Placeholders = { "name", "name2", "name3", "place", "skill" };

        public static List<string> Problems(CommentaryTemplates standard, CommentaryPackDef pack)
        {
            var p = new List<string>();
            if (pack == null || pack.IsStandard) return p;
            if (!pack.Phrases.TryGetValue(Loc.Ja, out var ja) || ja.Count == 0) { p.Add("no Japanese phrases"); return p; }
            // every standard base kind: the pack's Japanese or its explicit fallback
            foreach (var key in standard.Phrases.Keys)
                if (key.IndexOf('@') < 0 && !ja.ContainsKey(key) && !pack.CoveredByFallback(key)) p.Add("kind " + key + " is neither in phrases.ja nor in fallback");
            pack.Phrases.TryGetValue(standard.Language, out var mine);
            foreach (var kv in mine ?? new Dictionary<string, List<PhraseVariant>>())
            {
                int at = kv.Key.IndexOf('@');
                string baseKind = at > 0 ? kv.Key.Substring(0, at) : kv.Key;
                if (!standard.Phrases.TryGetValue(kv.Key, out var std) && !standard.Phrases.TryGetValue(baseKind, out std)) { p.Add("unknown kind " + kv.Key); continue; }
                var allowed = new HashSet<string>();
                foreach (var v in std.Variants) foreach (var part in v.Parts) if (part.Placeholder != null) allowed.Add(part.Placeholder);
                if (kv.Value.Count == 0) p.Add(kv.Key + ": no variants");
                foreach (var v in kv.Value)
                {
                    if (string.IsNullOrEmpty(v.Text)) { p.Add(kv.Key + ": empty text"); continue; }
                    if (v.Id == null || !v.Id.StartsWith(pack.Id + "_", StringComparison.Ordinal)) p.Add(kv.Key + ": variant id " + v.Id + " must start with " + pack.Id + "_");
                    foreach (var ph in PlaceholdersOf(v.Text))
                    {
                        if (Array.IndexOf(Placeholders, ph) < 0) p.Add(v.Id + ": unknown placeholder {" + ph + "}");
                        else if (!allowed.Contains(ph)) p.Add(v.Id + ": placeholder {" + ph + "} is not used by the standard " + kv.Key);
                    }
                }
            }
            return p;
        }

        public static List<string> PlaceholdersOf(string text)
        {
            var r = new List<string>();
            int i = 0;
            while ((i = text.IndexOf('{', i)) >= 0)
            {
                int close = text.IndexOf('}', i);
                if (close < 0) { r.Add(text.Substring(i + 1)); break; }
                r.Add(text.Substring(i + 1, close - i - 1));
                i = close + 1;
            }
            return r;
        }
    }

    /// <summary>A sample: key lines of the stock race, played back to back (ticks from the start of the sample).</summary>
    public sealed class CommentarySampleResult
    {
        public string PackId;
        /// <summary>The lines in race order; <see cref="Offsets"/>[i] is when line i starts in the sample.</summary>
        public List<CommentaryLine> Lines = new List<CommentaryLine>();
        public List<int> Offsets = new List<int>();
        /// <summary>Length of the sample in ticks (at most Seconds × tick rate).</summary>
        public int TotalTicks;
        public int Offset(CommentaryLine l) => Offsets[Lines.IndexOf(l)];
        /// <summary>The line on air at <paramref name="tick"/> ticks into the sample (null between lines / after the end).</summary>
        public CommentaryLine At(int tick)
        {
            for (int i = 0; i < Lines.Count; i++) if (tick >= Offsets[i] && tick < Offsets[i] + Lines[i].DurationTicks) return Lines[i];
            return null;
        }
    }

    /// <summary>
    /// REQ-CMT-008 try before buy: runs the catalog's stock race (CPU only, no player) on the device and picks its key
    /// lines in the given templates (a pack applied, or the standard) — the winner, the final-straight call, the gate, the
    /// result, a duel / photo finish and the first leader call, in that order of importance, as many as fit in
    /// <c>Seconds</c> — and plays them back to back in race order. Deterministic: the same pack always gives the same
    /// sample. No server call.
    /// </summary>
    public static class CommentarySample
    {
        public const string RaceId = "commentary_sample";

        public static RaceConfig Config(CommentarySampleSpec spec, RulesetParams ruleset)
        {
            var cfg = new RaceConfig { RaceId = RaceId, Mode = RaceMode.Friend, Seed = spec.Seed, Ruleset = ruleset, Track = spec.Track };
            for (int i = 0; i < spec.Horses.Count; i++) cfg.Entrants.Add(new Entrant { Slot = i, Kind = EntrantKind.Cpu, CpuLevel = 3, Horse = spec.Horses[i] });
            cfg.Validate();
            return cfg;
        }

        public static CommentarySampleResult Build(CommentarySampleSpec spec, RulesetParams ruleset, CommentaryTemplates templates)
        {
            var cfg = Config(spec, ruleset);
            var race = new OfflineRace(cfg, -1);
            var com = new Commentator(templates, cfg, -1);
            int guard = 0;
            while (!race.IsFinished && guard++ < 20000) { race.StepOnce(); com.Process(race.Sim); }
            com.Process(race.Sim);
            var all = com.Lines;
            int budget = spec.Seconds * cfg.Net.TickHz;
            var picks = new List<CommentaryLine>();
            int used = 0;
            void Pick(CommentaryLine l)
            {
                if (l == null || picks.Contains(l) || used + l.DurationTicks > budget) return;
                picks.Add(l);
                used += l.DurationTicks;
            }
            CommentaryLine First(Func<CommentaryLine, bool> f) { foreach (var l in all) if (f(l)) return l; return null; }
            Pick(First(l => Commentator.IsWinKind(l.Kind)));
            Pick(First(l => l.Kind == "spurt"));
            Pick(First(l => l.Kind == "gate_open"));
            Pick(First(l => l.Kind.StartsWith("result", StringComparison.Ordinal)));
            Pick(First(l => l.Kind == "photo_finish" || l.Kind == "duel"));
            Pick(First(l => l.Kind == "leader"));
            picks.Sort((x, y) => x.Tick.CompareTo(y.Tick));
            var r = new CommentarySampleResult { PackId = templates.PackId };
            int at = 0;
            foreach (var l in picks) { r.Lines.Add(l); r.Offsets.Add(at); at += l.DurationTicks; }
            r.TotalTicks = at;
            return r;
        }
    }

    /// <summary>REQ-CMT-006: a line is voiced only when every clip of it is on the device; otherwise subtitles only.</summary>
    public static class CommentaryVoice
    {
        /// <summary>Asset keys of the line's clips, or null when any clip cannot be voiced (unknown name, not downloaded).</summary>
        public static List<string> ClipsOrNull(CommentaryLine line, Func<string, string> horseNameById, Func<string, bool> isDownloaded, Func<string, string> skillNameById = null)
        {
            if (line?.ClipKeys == null) return null;
            var keys = new List<string>();
            foreach (var c in line.ClipKeys)
            {
                var k = AssetKeys.VoiceClip(c, horseNameById, skillNameById);
                if (k == null || isDownloaded == null || !isDownloaded(k)) return null;
                keys.Add(k);
            }
            return keys;
        }
    }

    // ------------------------------------------------------------------------------------------------ server API

    public sealed class CommentaryPackUnlock
    {
        public string AchievementId, Label;
        public int Tier, Progress, Target;
        internal static CommentaryPackUnlock Parse(JsonNode o) => o == null ? null : new CommentaryPackUnlock
        {
            AchievementId = J.Str(o, "achievementId"), Tier = J.Int(o, "tier"), Label = J.Str(o, "label"), Progress = J.Int(o, "progress"), Target = J.Int(o, "target"),
        };
    }

    /// <summary>One pack in GET /v1/commentary/packs (names already in the request language).</summary>
    public sealed class CommentaryPackInfo
    {
        public string Id, Name, Description, Acquire, Currency, English, EnglishNote;
        public int? Price;
        public bool ForSale, Owned, Equipped;
        public CommentaryPackUnlock Unlock;
        internal static CommentaryPackInfo Parse(JsonNode o) => new CommentaryPackInfo
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Description = J.Str(o, "description"), Acquire = J.Str(o, "acquire"),
            Price = J.IntN(o, "price"), Currency = J.Str(o, "currency"), ForSale = J.Bool(o, "forSale"), Owned = J.Bool(o, "owned"), Equipped = J.Bool(o, "equipped"),
            Unlock = CommentaryPackUnlock.Parse(J.Opt(o, "unlock")), English = J.Str(o, "english") ?? "own", EnglishNote = J.Str(o, "englishNote"),
        };
    }

    public sealed class CommentaryPacksView
    {
        public string Equipped = CommentaryPackCatalog.StandardPackId;
        public string Notice;
        public int SampleSeconds = 10;
        public List<CommentaryPackInfo> Packs = new List<CommentaryPackInfo>();
        public CommentaryPackInfo Find(string id) => Packs.Find(p => p.Id == id);
        internal static CommentaryPacksView Parse(JsonNode o) => o == null ? new CommentaryPacksView() : new CommentaryPacksView
        {
            Equipped = J.Str(o, "equipped") ?? CommentaryPackCatalog.StandardPackId, Notice = J.Str(o, "notice"),
            SampleSeconds = J.Int(J.Opt(o, "sample"), "seconds", 10), Packs = J.List(o, "packs", CommentaryPackInfo.Parse),
        };
    }

    public sealed class CommentaryPackPurchase
    {
        public string PackId;
        public int SpentPaid, SpentFree;
        public Wallet Wallet;
        public CommentaryPacksView View;
        internal static CommentaryPackPurchase Parse(JsonNode o)
        {
            var sp = J.Opt(o, "spent");
            return new CommentaryPackPurchase { PackId = J.Str(o, "packId"), SpentPaid = J.Int(sp, "paid"), SpentFree = J.Int(sp, "free"), Wallet = Wallet.Parse(J.Opt(o, "wallet")), View = CommentaryPacksView.Parse(J.Opt(o, "view")) };
        }
    }

    /// <summary>Where the pack was equipped (KPI commentary_pack_equip s3).</summary>
    public enum CommentaryEquipSource { Settings, Shop }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-CMT-011: owned / price / equipped / achievement progress / sample.</summary>
        public Task<CommentaryPacksView> GetCommentaryPacksAsync(CancellationToken ct = default)
            => Call("GET", "/v1/commentary/packs", null, true, null, true, CommentaryPacksView.Parse, ct);

        /// <summary>REQ-CMT-009: owned packs only (NOT_ELIGIBLE otherwise). Idempotent.</summary>
        public Task<CommentaryPacksView> EquipCommentaryPackAsync(string packId, CommentaryEquipSource source = CommentaryEquipSource.Settings, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("packId", packId);
            b.Set("source", source == CommentaryEquipSource.Shop ? "shop" : "settings");
            return Call("PUT", "/v1/commentary/equipped", b, true, null, true, CommentaryPacksView.Parse, ct);
        }

        /// <summary>
        /// REQ-CMT-010: buy for coins (paid first; INSUFFICIENT_COINS carries the T6 shortfall). Reuse the same
        /// idempotency key when retrying the same purchase.
        /// </summary>
        public Task<CommentaryPackPurchase> BuyCommentaryPackAsync(string packId, bool equip = false, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/commentary/packs/" + Seg(packId) + "/buy", JsonNode.Obj().Set("equip", equip), true, idempotencyKey ?? NewIdempotencyKey(), true, CommentaryPackPurchase.Parse, ct);
    }
}
