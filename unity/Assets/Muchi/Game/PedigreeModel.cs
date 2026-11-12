using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-PED-001..020 (contracts/protocol.md §71, docs/handoff-codex-round23-pedigree.md): 血統図と系統, the game layer.
    // Pure C#: Codex's screens bind to the public members. Read only — nothing here moves coins or items, every chance and count
    // is the server's (the existing breeding rules), and holding more bloodlines earns nothing.

    /// <summary>The server calls the pedigree screens need (ApiClient in the app, a fake in the checks).</summary>
    public interface IPedigreeApi
    {
        Task<PedigreeView> GetPedigreeViewAsync(string horseId, string playerId = null, string knownRev = null, CancellationToken ct = default);
        Task<BreedingPedigree> GetBreedingPedigreeAsync(string sireId, string damId, CancellationToken ct = default);
        Task<BloodlineList> GetBloodlinesAsync(CancellationToken ct = default);
    }

    /// <summary><see cref="IPedigreeApi"/> over the real client.</summary>
    public sealed class ApiPedigree : IPedigreeApi
    {
        private readonly ApiClient _api;
        public ApiPedigree(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<PedigreeView> GetPedigreeViewAsync(string horseId, string playerId = null, string knownRev = null, CancellationToken ct = default) => _api.GetPedigreeViewAsync(horseId, playerId, knownRev, ct);
        public Task<BreedingPedigree> GetBreedingPedigreeAsync(string sireId, string damId, CancellationToken ct = default) => _api.GetBreedingPedigreeAsync(sireId, damId, ct);
        public Task<BloodlineList> GetBloodlinesAsync(CancellationToken ct = default) => _api.GetBloodlinesAsync(ct);
    }

    /// <summary>One box of the 3-generation tree, ready to draw.</summary>
    public sealed class PedigreeBox
    {
        public int Slot, Gen;
        /// <summary>父 / 母の父 … (fixed text, translated at the boundary like every UI label).</summary>
        public string Relation;
        /// <summary>Null = no ancestor known in this slot (the box is drawn empty, no line to it).</summary>
        public PedigreeNode Node;
        public bool Empty => Node == null;
        public bool Shared => Node != null && Node.Shared;
        public bool NoRecord => Node != null && Node.Rec == null;
        /// <summary>Owner line under a borrowed stallion: the owner's name (as typed) or 「他のトレーナーの馬」.</summary>
        public string OwnerLine => Node == null || !Node.IsLent ? null : Node.LentOwnerName ?? Node.LentLabel;
        /// <summary>Second line: 脚質 · 馬場 · 固有スキル (empty for a box without a record).</summary>
        public string TraitLine
        {
            get
            {
                var r = Node?.Rec;
                if (r == null) return Node?.RecordText ?? "";
                var parts = new List<string> { PedigreeModel.StyleText(r.Style) };
                if (r.GoingAptitude != "any") parts.Add(PedigreeModel.GoingText(r.GoingAptitude));
                if (!string.IsNullOrEmpty(r.SkillName)) parts.Add(r.SkillName);
                return string.Join("・", parts);
            }
        }
        /// <summary>The look: the template portrait key, or null to compose from <see cref="PedigreeRecord.Appearance"/>.</summary>
        public string ThumbKey => Node?.Rec?.ThumbKey;
    }

    /// <summary>
    /// The 血統図 screen. Rules the model keeps:
    ///  - the tree is the server's (3 generations shown; 14 ancestor boxes in fixed slots, <see cref="PedigreeTree"/>);
    ///  - shared ancestors (the existing inbreeding rule) get the cyan frame and 「共通」; the inbreeding line quotes the server's
    ///    numbers (count × penalty), never a client constant;
    ///  - an ancestor with no record shows 「記録なし」; a borrowed stallion shows its owner only when the server named them;
    ///  - another player's tree hides nothing more than the server did (under-13 names arrive already hidden);
    ///  - the answer is cached per (player, horse) for the session and revalidated with its rev (304 → keep);
    ///    <see cref="ForgetCache"/> on an account change (AccountChangeReset);
    ///  - KPI: pedigree_view once per opened tree, bloodline_view once per opened list.
    /// </summary>
    public sealed class PedigreeModel
    {
        public const string Title = "血統";
        public const string BloodlinesTitle = "系統";
        public const string BloodlinesLink = "系統 ›";
        public const string SeePedigreeLabel = "血統を見る";
        public const string SharedBadge = "共通";
        public const string FounderBadge = "系統の祖";
        public const string OfflineText = "血統はオンラインで見られます";
        public const string HiddenText = "この馬の血統は見られません";
        public const string HintsTitle = "この組み合わせで受け継ぎやすい能力";
        public const string NoSharedText = "3代以内に共通の祖先はいません";

        private readonly IPedigreeApi _api;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;
        private readonly Dictionary<string, PedigreeView> _cache = new Dictionary<string, PedigreeView>();

        public PedigreeModel(IPedigreeApi api, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            _api = api ?? throw new ArgumentNullException(nameof(api));
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public PedigreeView View { get; private set; }
        public BreedingPedigree Pair { get; private set; }
        public BloodlineList Bloodlines { get; private set; }
        public string Message { get; private set; }
        public List<PedigreeBox> Boxes { get; private set; } = new List<PedigreeBox>();
        /// <summary>Requests answered 304 (kept from the cache).</summary>
        public int Revalidated { get; private set; }

        private static string CacheKey(string playerId, string horseId) => (playerId ?? "") + "|" + horseId;

        /// <summary>Opens a tree. <paramref name="playerId"/> = another player's horse (only while it is shown publicly).</summary>
        public async Task<bool> OpenAsync(string horseId, string source, string playerId = null, CancellationToken ct = default)
        {
            Message = null;
            var key = CacheKey(playerId, horseId);
            _cache.TryGetValue(key, out var held);
            try
            {
                var v = await _api.GetPedigreeViewAsync(horseId, playerId, held?.Rev, ct);
                if (v == null && held != null) { v = held; Revalidated++; }
                if (v == null) { Message = HiddenText; return false; }
                _cache[key] = v;
                Show(v);
                _track?.Invoke(AnalyticsEvent.PedigreeView(_clock(), source, v.Relation, Boxes.Count(b => b.Shared)));
                return true;
            }
            catch (NotFoundException) { _cache.Remove(key); View = null; Boxes = new List<PedigreeBox>(); Message = HiddenText; return false; }
            catch (NetworkException)
            {
                if (held != null) { Show(held); return true; }
                Message = OfflineText;
                return false;
            }
        }

        private void Show(PedigreeView v)
        {
            View = v;
            var slots = PedigreeTree.Slots(v.Root);
            Boxes = Enumerable.Range(0, PedigreeTree.SlotCount).Select(i => new PedigreeBox { Slot = i, Gen = PedigreeTree.GenOf(i), Relation = PedigreeTree.Label(i), Node = slots[i] }).ToList();
        }

        /// <summary>Tapping an ancestor that is one of my own horses opens its tree (others' ancestors are not opened).</summary>
        public bool CanOpenAncestor(PedigreeBox b) => View != null && View.IsMine && b?.Node?.HorseId != null && b.Slot > 0;

        /// <summary>「近親：共通の祖先2頭（能力の基準 −100）」 from the server's numbers; null when there is none.</summary>
        public string InbreedingLine => View == null || View.InbreedingCount == 0 ? null : "近親：共通の祖先" + View.InbreedingCount + "頭（能力の基準 −" + View.StatPenalty + "）";

        /// <summary>The breeding pair's 「血統を見る」: both trees, the shared ancestors and the hints.</summary>
        public async Task<bool> OpenPairAsync(string sireId, string damId, CancellationToken ct = default)
        {
            Message = null;
            try
            {
                Pair = await _api.GetBreedingPedigreeAsync(sireId, damId, ct);
                _track?.Invoke(AnalyticsEvent.PedigreeView(_clock(), PedigreeSources.Breeding, "self", Math.Min(14, Pair.SharedKeys.Count)));
                return true;
            }
            catch (NetworkException) { Message = OfflineText; return false; }
        }

        /// <summary>The pair's shared-ancestor line for the breeding screen (server count × server penalty).</summary>
        public string PairSharedLine => Pair == null ? null : Pair.InbreedingCount == 0 ? NoSharedText
            : "共通の祖先 " + string.Join("・", Pair.Shared.Select(x => x.Value)) + "（能力の基準 −" + Pair.StatPenalty + "）";

        public async Task<bool> OpenBloodlinesAsync(string source, CancellationToken ct = default)
        {
            Message = null;
            try
            {
                Bloodlines = await _api.GetBloodlinesAsync(ct);
                _track?.Invoke(AnalyticsEvent.BloodlineView(_clock(), source, Bloodlines.Lines.Count));
                return true;
            }
            catch (NetworkException) { Message = OfflineText; return false; }
        }

        /// <summary>A line's count text: 「4頭（現役2・引退2）」. Never a "complete" or "collected" state.</summary>
        public static string CountText(Bloodline l) => l.Count + "頭（現役" + l.Active + "・引退" + l.Retired + "）";
        /// <summary>「ニックス：ミナモ系（母）+30」 per partner.</summary>
        public static List<string> NickLines(Bloodline l) => l.NickWith.Select(n => "ニックス：" + n.LineName + "（" + (n.Role == "dam" ? "母" : "父") + "）+" + n.Bonus).ToList();

        public static string StyleText(string style) => style switch { "nige" => "逃げ", "senko" => "先行", "sashi" => "差し", "oikomi" => "追込", _ => style ?? "" };
        public static string GoingText(string going) => going switch { "fast" => "良馬場が得意", "heavy" => "重馬場が得意", _ => "馬場を問わない" };

        /// <summary>AccountChangeReset: nothing of the previous account's trees stays on the device.</summary>
        public void ForgetCache() { _cache.Clear(); View = null; Pair = null; Bloodlines = null; Boxes = new List<PedigreeBox>(); }
        public int CachedTrees => _cache.Count;
    }
}
