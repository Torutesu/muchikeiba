using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-PED-001..020: 血統図と系統 (server/src/domain/pedigree.ts, contracts/protocol.md §71).
    // Read only: a horse's 3-generation tree, the breeding pair's shared ancestors and inheritance hints, and the bloodline (sire
    // line) list. Every number shown comes from the server's existing breeding rules — the client invents no chance and adds no
    // rule. Nothing here moves coins or items, and holding more lines earns nothing (no set-collection reward).
    // Player-typed names (horse names, OwnerName) are shown as written and never translated.

    /// <summary>Where a pedigree tree was opened from (`pedigree_view` source).</summary>
    public static class PedigreeSources
    {
        public const string Horse = "horse", Breeding = "breeding", Stable = "stable", Showcase = "showcase", Bloodlines = "bloodlines";
        public static readonly string[] All = { Horse, Breeding, Stable, Showcase, Bloodlines };
    }

    /// <summary>Where the bloodline list was opened from (`bloodline_view` source).</summary>
    public static class BloodlineSources
    {
        public const string Breeding = "breeding", Pedigree = "pedigree", Help = "help";
        public static readonly string[] All = { Breeding, Pedigree, Help };
    }

    /// <summary>One ancestor's record (`rec`): live from the stable, or the snapshot taken when the foal was born.</summary>
    public sealed class PedigreeRecord
    {
        public string Source, Rarity, Sex, Style, GoingAptitude, Surface, Line, LineName, ThumbKey, SkillId, SkillName, Status, BestText;
        public Appearance Appearance;
        public int StatTotal;
        /// <summary>Only on my own horses (null for another player's tree).</summary>
        public Stats Stats;
        /// <summary>The §34 career (null for a snapshot ancestor).</summary>
        public bool HasBest;
        public int Races, Wins, Places, TournamentWins;
        public bool IsSnapshot => Source == "snapshot";

        internal static PedigreeRecord Parse(JsonNode o)
        {
            if (o == null) return null;
            var sk = J.Opt(o, "skill");
            var b = J.Opt(o, "best");
            return new PedigreeRecord
            {
                Source = J.Str(o, "source"), Rarity = J.Str(o, "rarity"), Sex = J.Str(o, "sex"), Style = J.Str(o, "style"),
                GoingAptitude = J.Str(o, "goingAptitude") ?? "any", Surface = J.Str(o, "surface"), Line = J.Str(o, "line"), LineName = J.Str(o, "lineName"),
                ThumbKey = J.Str(o, "thumbKey"), SkillId = J.Str(sk, "id"), SkillName = J.Str(sk, "name"), Status = J.Str(o, "status"),
                BestText = J.Str(o, "bestText"), Appearance = Appearance.Parse(J.Opt(o, "appearance")), StatTotal = J.Int(o, "statTotal"),
                Stats = J.Opt(o, "stats") == null ? null : Stats.Parse(J.Opt(o, "stats")),
                HasBest = b != null, Races = J.Int(b, "races"), Wins = J.Int(b, "wins"), Places = J.Int(b, "places"), TournamentWins = J.Int(b, "tournamentWins"),
            };
        }
    }

    /// <summary>GET /v1/horses/:id/pedigree (v2): the root node plus the tree-wide facts.</summary>
    public sealed class PedigreeView
    {
        public PedigreeNode Root;
        public string Relation, Line, LineName, Rev;
        public int Generations, InbreedingCount, PenaltyPerAncestor, StatPenalty;
        public List<string> SharedKeys = new List<string>();
        /// <summary>The owner is under 13: their typed names are hidden (nodes carry <see cref="PedigreeNode.NameHidden"/>).</summary>
        public bool Young;
        public bool IsMine => Relation == "self";

        public static PedigreeView Parse(JsonNode o)
        {
            if (o == null) return null;
            var inb = J.Opt(o, "inbreeding");
            return new PedigreeView
            {
                Root = PedigreeNode.Parse(o), Relation = J.Str(o, "relation") ?? "self", Line = J.Str(o, "line"), LineName = J.Str(o, "lineName"),
                Rev = J.Str(o, "rev"), Generations = J.Int(o, "generations"), InbreedingCount = J.Int(inb, "count"), PenaltyPerAncestor = J.Int(inb, "penaltyPerAncestor"),
                StatPenalty = J.Int(inb, "statPenalty"), SharedKeys = J.List(o, "sharedKeys", x => x.AsString()), Young = J.Bool(o, "young"),
            };
        }
        public static PedigreeView FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    /// <summary>
    /// The 3-generation tree in fixed slots (heap order: 0 = the horse, 1 = sire, 2 = dam, 3..6 grandparents, 7..14
    /// great-grandparents; the sire of slot i is 2i+1, the dam 2i+2) and how the screen flows it.
    /// </summary>
    public static class PedigreeTree
    {
        public const int Generations = 3;
        public const int SlotCount = 15;

        public static PedigreeNode[] Slots(PedigreeNode root)
        {
            var s = new PedigreeNode[SlotCount];
            s[0] = root;
            for (int i = 0; 2 * i + 2 < SlotCount; i++)
            {
                if (s[i] == null) continue;
                s[2 * i + 1] = s[i].Sire;
                s[2 * i + 2] = s[i].Dam;
            }
            return s;
        }

        /// <summary>Generation of a slot (0..3).</summary>
        public static int GenOf(int slot) => slot <= 0 ? 0 : slot <= 2 ? 1 : slot <= 6 ? 2 : 3;
        /// <summary>The slot's label: 父 / 母 / 父の父 / 母の母 …</summary>
        public static string Label(int slot)
        {
            if (slot <= 0) return "本人";
            var path = new List<string>();
            for (int i = slot; i > 0; i = (i - 1) / 2) path.Insert(0, (i % 2 == 1) ? "父" : "母");
            return string.Join("の", path);
        }

        /// <summary>Columns (left → right) on a wide screen, rows (top → bottom) on a narrow one or at the largest text size (REQ-PED-017).</summary>
        public enum Flow { Columns, Rows }
        public static Flow FlowFor(int widthPt, float textScale) => widthPt < 600 || textScale >= 1.3f ? Flow.Rows : Flow.Columns;

        /// <summary>Slots in reading order for the flow: by generation, sire side first.</summary>
        public static int[] Order(Flow f) => Enumerable.Range(0, SlotCount).OrderBy(GenOf).ThenBy(i => i).ToArray();
    }

    /// <summary>One "この組み合わせで受け継ぎやすい能力" line, built by the server from the breeding preview.</summary>
    public sealed class PedigreeHint
    {
        public string Kind, Text;
        /// <summary>The chance as the server wrote it (permille, may be fractional "13.333"); null for counts (nick, inbreeding, stat).</summary>
        public string Permille;
        public int? Value;
        internal static PedigreeHint Parse(JsonNode o) => new PedigreeHint { Kind = J.Str(o, "kind"), Text = J.Str(o, "hintText"), Permille = J.Str(o, "permille"), Value = J.IntN(o, "value") };
    }

    /// <summary>GET /v1/breeding/pedigree: both parents' trees, shared ancestors (= the server's inbreeding count) and hints.</summary>
    public sealed class BreedingPedigree
    {
        public PedigreeNode Sire, Dam;
        public List<string> SharedKeys = new List<string>();
        public List<KeyValuePair<string, string>> Shared = new List<KeyValuePair<string, string>>();
        public int InbreedingCount, PenaltyPerAncestor, StatPenalty, NickBonus;
        public bool Nick;
        public List<PedigreeHint> Hints = new List<PedigreeHint>();
        public string LineId, LineName, Notice;
        public bool IsShared(PedigreeNode n) => n != null && SharedKeys.Contains(n.Key);

        public static BreedingPedigree Parse(JsonNode o)
        {
            var inb = J.Opt(o, "inbreeding");
            var nick = J.Opt(o, "nick");
            var line = J.Opt(o, "line");
            return new BreedingPedigree
            {
                Sire = PedigreeNode.Parse(J.Opt(o, "sire")), Dam = PedigreeNode.Parse(J.Opt(o, "dam")),
                SharedKeys = J.List(o, "sharedKeys", x => x.AsString()),
                Shared = J.List(o, "shared", x => new KeyValuePair<string, string>(J.Str(x, "key"), J.Str(x, "name"))),
                InbreedingCount = J.Int(inb, "count"), PenaltyPerAncestor = J.Int(inb, "penaltyPerAncestor"), StatPenalty = J.Int(inb, "statPenalty"),
                Nick = J.Bool(nick, "on"), NickBonus = J.Int(nick, "bonus"), Hints = J.List(o, "hints", PedigreeHint.Parse),
                LineId = J.Str(line, "id"), LineName = J.Str(line, "lineName"), Notice = J.Str(o, "notice"),
            };
        }
        public static BreedingPedigree FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    public sealed class BloodlineNick
    {
        public string Id, LineName, Role;
        public int Bonus;
        internal static BloodlineNick Parse(JsonNode o) => new BloodlineNick { Id = J.Str(o, "id"), LineName = J.Str(o, "lineName"), Role = J.Str(o, "role"), Bonus = J.Int(o, "bonus") };
    }

    public sealed class BloodlineHorse
    {
        public string HorseId, Name, Sex, Status, Rarity;
        internal static BloodlineHorse Parse(JsonNode o) => new BloodlineHorse { HorseId = J.Str(o, "horseId"), Name = J.Str(o, "name"), Sex = J.Str(o, "sex"), Status = J.Str(o, "status"), Rarity = J.Str(o, "rarity") };
    }

    public sealed class Bloodline
    {
        public string Id, LineName, FounderName, Note;
        public int Count, Active, Retired;
        public List<BloodlineNick> NickWith = new List<BloodlineNick>();
        public List<BloodlineHorse> Horses = new List<BloodlineHorse>();
        internal static Bloodline Parse(JsonNode o) => new Bloodline
        {
            Id = J.Str(o, "id"), LineName = J.Str(o, "lineName"), FounderName = J.Str(o, "founderName"), Note = J.Str(o, "note"),
            Count = J.Int(o, "count"), Active = J.Int(o, "active"), Retired = J.Int(o, "retired"),
            NickWith = J.List(o, "nickWith", BloodlineNick.Parse), Horses = J.List(o, "horses", BloodlineHorse.Parse),
        };
    }

    /// <summary>GET /v1/bloodlines. Lines in master order, empty ones included; there is no "complete" state and no reward.</summary>
    public sealed class BloodlineList
    {
        public List<Bloodline> Lines = new List<Bloodline>();
        public int Total, Unlisted, NickBonus, InbreedingPenalty, Generations;
        public string Notice;
        public Bloodline Line(string id) => Lines.FirstOrDefault(l => l.Id == id);

        public static BloodlineList Parse(JsonNode o)
        {
            var r = J.Opt(o, "rules");
            return new BloodlineList
            {
                Lines = J.List(o, "lines", Bloodline.Parse), Total = J.Int(o, "total"), Unlisted = J.Int(o, "unlisted"),
                NickBonus = J.Int(r, "nickBonus"), InbreedingPenalty = J.Int(r, "inbreedingPenalty"), Generations = J.Int(r, "generations"), Notice = J.Str(o, "notice"),
            };
        }
        public static BloodlineList FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    public sealed partial class ApiClient
    {
        /// <summary>
        /// REQ-PED-003..008: a horse's tree (mine, or another player's while it is shown publicly — <paramref name="playerId"/>).
        /// With <paramref name="knownRev"/> (the <see cref="PedigreeView.Rev"/> held for this horse) the server answers 304 when
        /// nothing changed: the task then returns null and the caller keeps its copy.
        /// </summary>
        public Task<PedigreeView> GetPedigreeViewAsync(string horseId, string playerId = null, string knownRev = null, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(horseId)) throw new ArgumentException("horse id", nameof(horseId));
            var path = "/v1/horses/" + Seg(horseId) + "/pedigree" + (string.IsNullOrEmpty(playerId) ? "" : "?playerId=" + Uri.EscapeDataString(playerId));
            var headers = string.IsNullOrEmpty(knownRev) ? null : new Dictionary<string, string> { { "if-none-match", "\"" + knownRev + "-" + Locale + "\"" } };
            return Call("GET", path, null, true, null, true, o => o == null || o.IsNull ? null : PedigreeView.Parse(o), ct, headers);
        }

        /// <summary>REQ-PED-009/010: the breeding pair's trees, shared ancestors and inheritance hints (own retired stallion × mare).</summary>
        public Task<BreedingPedigree> GetBreedingPedigreeAsync(string sireId, string damId, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(sireId) || string.IsNullOrEmpty(damId)) throw new ArgumentException("sire and dam ids are required");
            return Call("GET", "/v1/breeding/pedigree?sireId=" + Uri.EscapeDataString(sireId) + "&damId=" + Uri.EscapeDataString(damId), null, true, null, true, BreedingPedigree.Parse, ct);
        }

        /// <summary>REQ-PED-012: the bloodline list of my stable.</summary>
        public Task<BloodlineList> GetBloodlinesAsync(CancellationToken ct = default)
            => Call("GET", "/v1/bloodlines", null, true, null, true, BloodlineList.Parse, ct);
    }

    public sealed partial class AnalyticsEvent
    {
        /// <summary>REQ-PED-016: a tree was opened (where from, whose, how many shared ancestors it highlighted, 0..14). No ids.</summary>
        public static AnalyticsEvent PedigreeView(long atMs, string source, string relation, int shared)
        {
            if (Array.IndexOf(PedigreeSources.All, source) < 0) throw new ArgumentException("unknown pedigree source " + source);
            if (relation != "self" && relation != "friend" && relation != "other") throw new ArgumentException("unknown relation " + relation);
            return new AnalyticsEvent("pedigree_view", atMs, JsonNode.Obj().Set("source", source).Set("relation", relation).Set("shared", Math.Max(0, Math.Min(14, shared))));
        }

        /// <summary>REQ-PED-016: the bloodline list was opened (where from, how many lines, 0..64).</summary>
        public static AnalyticsEvent BloodlineView(long atMs, string source, int lines)
        {
            if (Array.IndexOf(BloodlineSources.All, source) < 0) throw new ArgumentException("unknown bloodline source " + source);
            return new AnalyticsEvent("bloodline_view", atMs, JsonNode.Obj().Set("source", source).Set("lines", Math.Max(0, Math.Min(64, lines))));
        }
    }
}
