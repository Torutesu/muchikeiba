using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-COL-001..005 図鑑, REQ-ACH-001..009 実績 and the one title list (REQ-TITLE-*, REQ-ACH-006); contracts/protocol.md §22.
    // Pure C#: Codex's screens bind to the public fields and call the async actions from the main thread.
    //
    // Rules the models keep for the screens (docs/planning/03 「図鑑・実績でコンプガチャを作らない理由」):
    //  - the book's completion is a number only: no reward, no "あと1体でもらえる" wording, no link from a missing horse to the
    //    scout screen (an unknown entry is a silhouette with "？？？", nothing to buy);
    //  - achievements count play only and pay free coins; their texts never mention scouting or buying;
    //  - claims keep their idempotency key until the server answers (a retry after a timeout never pays twice);
    //  - while the account is scheduled for deletion nothing can be claimed (DeletionGuard banner instead of the button).

    /// <summary>One cell of the collection grid (horses, skills, courses or cosmetics).</summary>
    public sealed class CollectionCell
    {
        public string Id, State, Title, Subtitle, Lore, Art, Rarity, Badge;
        public bool Obtained => State == "obtained";
        public bool Seen => State == "seen";
        public bool Unknown => State == "unknown";
        /// <summary>"入手" / "出会った" / "未発見" (courses: "走った" / "未出走"; cosmetics: "所持" / "未所持").</summary>
        public string StateLabel;
        /// <summary>Stat lines for an obtained horse ("スピード 820"), empty otherwise.</summary>
        public List<string> StatLines = new List<string>();
    }

    public sealed class CollectionModel : ScreenModel
    {
        public const string Unknown = "？？？";
        public static readonly string[] Tabs = { "horses", "skills", "courses", "cosmetics" };
        public static readonly IReadOnlyDictionary<string, string> TabLabels = new Dictionary<string, string>
        {
            ["horses"] = "競走馬", ["skills"] = "固有スキル", ["courses"] = "コース", ["cosmetics"] = "勝負服・見た目",
        };

        public CollectionModel(GameBackend backend) : base(backend, backend?.Store) { }

        public CollectionBook Book { get; private set; }
        public string Tab { get; private set; } = "horses";
        public List<CollectionCell> Cells { get; private set; } = new List<CollectionCell>();
        /// <summary>The cell opened in the detail panel (null = none).</summary>
        public CollectionCell Selected { get; private set; }
        /// <summary>Show only entries that are not unknown.</summary>
        public bool HideUnknown;

        /// <summary>"図鑑 達成率 50%（3/6）" for the header.</summary>
        public string TotalText => Book == null ? null : "図鑑 達成率 " + Book.Totals.CompletionText + "（" + Book.Totals.Obtained + "/" + Book.Totals.Total + "）";
        /// <summary>"入手 1 ・ 出会った 1 ・ 未発見 1" for the current tab.</summary>
        public string TabCountsText
        {
            get
            {
                var c = CountsOf(Tab);
                if (c == null) return null;
                if (Tab == "horses" || Tab == "skills") return "入手 " + c.Obtained + " ・ 出会った " + c.Seen + " ・ 未発見 " + c.Unknown;
                return (Tab == "courses" ? "走った " : "所持 ") + c.Obtained + " / " + c.Total;
            }
        }
        /// <summary>0..1 for the tab's meter.</summary>
        public float TabProgress { get { var c = CountsOf(Tab); return c == null || c.Total == 0 ? 0f : c.Obtained / (float)c.Total; } }
        /// <summary>The server's notice (completion pays nothing).</summary>
        public string Notice => Book?.Notice ?? "図鑑の達成率は記録の表示だけです。そろえても報酬はありません。";

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Book = null; Rebuild(); return Offline("図鑑はオンラインで表示されます"); }
            try
            {
                Book = await B.Api.GetCollectionAsync(ct);
                Online = true;
                Rebuild();
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public void SelectTab(string tab)
        {
            if (Array.IndexOf(Tabs, tab) < 0) return;
            Tab = tab;
            Selected = null;
            Rebuild();
        }

        public void SetHideUnknown(bool hide) { HideUnknown = hide; Rebuild(); }

        public void Open(string id) { Selected = Cells.FirstOrDefault(c => c.Id == id); }
        public void Close() { Selected = null; }

        private CollectionCounts CountsOf(string tab)
        {
            if (Book == null) return null;
            switch (tab)
            {
                case "horses": return Book.Horses.Counts;
                case "skills": return Book.Skills.Counts;
                case "courses": return Book.Courses.Counts;
                default: return Book.Cosmetics.Counts;
            }
        }

        private static string StyleName(string s)
        {
            switch (s) { case "nige": return "逃げ"; case "senko": return "先行"; case "sashi": return "差し"; case "oikomi": return "追込"; default: return s; }
        }

        private static string SurfaceName(string s) => s == "turf" ? "芝" : s == "dirt" ? "ダート" : s == "both" ? "芝・ダート" : s;

        private static string Label(string tab, string state)
        {
            if (tab == "courses") return state == "obtained" ? "走った" : "未出走";
            if (tab == "cosmetics") return state == "obtained" ? "所持" : "未所持";
            return state == "obtained" ? "入手" : state == "seen" ? "出会った" : "未発見";
        }

        private void Rebuild()
        {
            Cells = new List<CollectionCell>();
            if (Book == null) return;
            switch (Tab)
            {
                case "horses":
                    foreach (var h in Book.Horses.Entries)
                    {
                        var c = new CollectionCell
                        {
                            Id = h.Id, State = h.State, Rarity = h.Rarity, Art = h.Art ?? (h.Unknown ? AssetKeys.CollectionSilhouette(h.Id) : AssetKeys.CollectionPortrait(h.Id)),
                            Title = h.Unknown ? Unknown : h.Name,
                            Subtitle = h.Unknown ? h.Rarity : h.Rarity + " ・ " + StyleName(h.Style) + " ・ " + SurfaceName(h.Surface) + (h.DistMinM > 0 ? " " + h.DistMinM + "〜" + h.DistMaxM + "m" : ""),
                            Lore = h.Lore, Badge = h.SeasonalLabel, StateLabel = Label(Tab, h.State),
                        };
                        if (h.Stats != null)
                            c.StatLines = new List<string> { "スピード " + h.Stats.Speed, "スタミナ " + h.Stats.Stamina, "瞬発力 " + h.Stats.Burst, "根性 " + h.Stats.Guts, "気性 " + h.Stats.Temper };
                        Cells.Add(c);
                    }
                    break;
                case "skills":
                    foreach (var k in Book.Skills.Entries)
                        Cells.Add(new CollectionCell
                        {
                            Id = k.Id, State = k.State, Rarity = k.Rarity, Title = k.State == "unknown" ? Unknown : k.Name,
                            Subtitle = k.State == "unknown" ? k.Rarity : k.Condition, Lore = k.Lore,
                            StatLines = k.Effect != null ? new List<string> { k.Effect } : new List<string>(), StateLabel = Label(Tab, k.State),
                        });
                    break;
                case "courses":
                    foreach (var t in Book.Courses.Entries)
                    {
                        var c = new CollectionCell { Id = t.Id, State = t.State, Title = t.Name, Subtitle = SurfaceName(t.Surface) + " " + t.DistanceM + "m", Lore = t.Lore, StateLabel = Label(Tab, t.State) };
                        if (t.State == "obtained") c.StatLines = new List<string> { "出走 " + t.Races + " ・ 1着 " + t.Wins };
                        if (t.TimeAttackBestMs.HasValue) c.StatLines.Add("タイムアタック " + RaceTime(t.TimeAttackBestMs.Value));
                        Cells.Add(c);
                    }
                    break;
                default:
                    foreach (var x in Book.Cosmetics.Entries)
                        Cells.Add(new CollectionCell { Id = x.Id, State = x.State, Title = x.Name, Subtitle = x.Kind, Lore = x.Lore, Art = x.Icon, StateLabel = Label(Tab, x.State) });
                    break;
            }
            if (HideUnknown) Cells = Cells.Where(c => !c.Unknown).ToList();
        }

        /// <summary>"1:26.1".</summary>
        public static string RaceTime(int ms)
        {
            int tenths = ms / 100;
            return (tenths / 600).ToString(CultureInfo.InvariantCulture) + ":" + (tenths / 10 % 60).ToString("00", CultureInfo.InvariantCulture) + "." + (tenths % 10).ToString(CultureInfo.InvariantCulture);
        }
    }

    /// <summary>One achievement row: name, progress meter, the tier badges and the claim button.</summary>
    public sealed class AchievementRow
    {
        public string Id, Category, Name, Description, Badge;
        public int Progress, Tier, MaxTier;
        public int? NextTarget;
        /// <summary>"12/50" (or "達成" when every tier is reached).</summary>
        public string ProgressText;
        public float Meter;
        /// <summary>Tier badge keys in order, with whether each is reached.</summary>
        public List<(string badge, bool unlocked, bool claimed)> Badges = new List<(string, bool, bool)>();
        /// <summary>The lowest claimable tier (null = nothing to claim).</summary>
        public int? ClaimTier;
        /// <summary>"無償コイン10枚" for <see cref="ClaimTier"/>.</summary>
        public string ClaimText;
        /// <summary>"称号「大会の覇者」（1段）" for the titles this achievement unlocks.</summary>
        public List<string> TitleTexts = new List<string>();
    }

    public sealed class AchievementModel : ScreenModel
    {
        public const string KeyPending = "muchi.achievement.claim";
        public static readonly IReadOnlyDictionary<string, string> CategoryLabels = new Dictionary<string, string>
        {
            ["race"] = "レース", ["course"] = "コース", ["skill"] = "固有スキル", ["breeding"] = "配合", ["time_attack"] = "タイムアタック",
            ["tournament"] = "大会", ["stable"] = "マイ厩舎", ["team"] = "支部",
        };

        public AchievementModel(GameBackend backend) : base(backend, backend?.Store) { }

        public AchievementList Data { get; private set; }
        public List<AchievementRow> Rows { get; private set; } = new List<AchievementRow>();
        /// <summary>Filter by category (null = all).</summary>
        public string Category { get; private set; }
        public string Toast { get; private set; }
        public bool Blocked => Data != null && Data.Blocked;
        public string BlockedText => Blocked ? DeletionGuard.Banner(B) ?? DeletionGuard.Banner((long?)null) : null;
        public bool CanClaimAll => Data != null && !Blocked && Data.Totals.Claimable > 0;
        /// <summary>"受け取る（3件・無償コイン40枚）".</summary>
        public string ClaimAllText => CanClaimAll ? "まとめて受け取る（" + Data.Totals.Claimable + "件・無償コイン" + Data.Totals.ClaimableCoins + "枚）" : null;
        /// <summary>"実績 12/71段".</summary>
        public string TotalText => Data == null ? null : "実績 " + Data.Totals.Unlocked + "/" + Data.Totals.Tiers + "段";
        public string Notice => Data?.Notice ?? "実績はレースや育成などのプレイで達成します。課金やガチャの回数では達成しません。報酬は無償コインです。";

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Data = null; Rebuild(); return Offline("実績はオンラインで表示されます"); }
            try
            {
                Data = await B.Api.GetAchievementsAsync(ct);
                Online = true;
                Rebuild();
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public void SelectCategory(string category) { Category = category; Rebuild(); }

        public async Task<ActionResult> ClaimAsync(string achievementId, CancellationToken ct = default)
        {
            Toast = null;
            var row = Rows.Find(r => r.Id == achievementId);
            if (row == null || row.ClaimTier == null || Blocked) return ActionResult.Error(Blocked ? BlockedText : UxText.Errors["NOT_ELIGIBLE"]);
            int tier = row.ClaimTier.Value;
            string key = PendingKey(achievementId + ":" + tier.ToString(CultureInfo.InvariantCulture));
            try
            {
                var c = await B.Api.ClaimAchievementAsync(achievementId, tier, key, ct);
                Kv.Set(KeyPending, "");
                Toast = "実績「" + row.Name + "」" + tier + "段：無償コイン" + c.FreeCoins + "枚";
                await ReloadAfterClaim(ct);
                return ActionResult.Success(Toast);
            }
            catch (ApiException e) { return Failed(e); }
        }

        public async Task<ActionResult> ClaimAllAsync(CancellationToken ct = default)
        {
            Toast = null;
            if (!CanClaimAll) return ActionResult.Error(Blocked ? BlockedText : UxText.Errors["NOT_ELIGIBLE"]);
            string key = PendingKey("all");
            try
            {
                var c = await B.Api.ClaimAllAchievementsAsync(key, ct);
                Kv.Set(KeyPending, "");
                Toast = c.Claimed.Count + "件の実績：無償コイン" + c.FreeCoins + "枚";
                await ReloadAfterClaim(ct);
                return ActionResult.Success(Toast);
            }
            catch (ApiException e) { return Failed(e); }
        }

        private async Task ReloadAfterClaim(CancellationToken ct)
        {
            try { Data = await B.Api.GetAchievementsAsync(ct); } catch (ApiException) { /* the toast is enough; the next load refreshes */ }
            Rebuild();
            await B.RefreshAsync(ct);
        }

        private string PendingKey(string scope)
        {
            var stored = (Kv.Get(KeyPending) ?? "").Split('|');
            if (stored.Length == 2 && stored[0] == scope) return stored[1];
            string key = B.Api.NewIdempotencyKey();
            Kv.Set(KeyPending, scope + "|" + key);
            return key;
        }

        private ActionResult Failed(ApiException e)
        {
            if (!GameBackend.IsTransient(e)) Kv.Set(KeyPending, "");
            Message = UxText.For(e);
            return ActionResult.Error(Message);
        }

        private void Rebuild()
        {
            Rows = new List<AchievementRow>();
            if (Data == null) return;
            foreach (var a in Data.Achievements)
            {
                if (Category != null && a.Category != Category) continue;
                var claim = Blocked ? null : a.Tiers.FirstOrDefault(t => t.Claimable);
                int prev = 0;
                foreach (var t in a.Tiers) if (t.Unlocked) prev = t.Target;
                var row = new AchievementRow
                {
                    Id = a.Id, Category = a.Category, Name = a.Name, Description = a.Description, Badge = a.Badge,
                    Progress = a.Progress, Tier = a.Tier, MaxTier = a.MaxTier, NextTarget = a.NextTarget,
                    ProgressText = a.NextTarget.HasValue ? Math.Min(a.Progress, a.NextTarget.Value) + "/" + a.NextTarget.Value : "達成",
                    Meter = a.NextTarget.HasValue ? Math.Max(0f, Math.Min(1f, (a.Progress - prev) / (float)Math.Max(1, a.NextTarget.Value - prev))) : 1f,
                    ClaimTier = claim?.Tier, ClaimText = claim != null ? "無償コイン" + claim.FreeCoins + "枚" : null,
                };
                foreach (var t in a.Tiers) row.Badges.Add((t.Badge, t.Unlocked, t.Claimed));
                foreach (var t in a.Titles) row.TitleTexts.Add("称号「" + t.Name + "」（" + t.Tier + "段）" + (t.Unlocked ? " 獲得済み" : ""));
                Rows.Add(row);
            }
            // claimable first, then in master order
            Rows = Rows.OrderBy(r => r.ClaimTier.HasValue ? 0 : 1).ToList();
        }
    }

    /// <summary>
    /// REQ-ACH-006 / REQ-TITLE-003: the one title list (records and achievement tiers) and the equipped title, shown on the
    /// profile and on the stable plate. Locked titles show how to earn them; nothing here can be bought.
    /// </summary>
    public sealed class TitleShowcaseModel : ScreenModel
    {
        public TitleShowcaseModel(GameBackend backend) : base(backend, backend?.Store) { }

        public TitleList Titles { get; private set; }
        public string EquippedId => Titles?.Equipped;
        public string EquippedName => Titles?.Titles.FirstOrDefault(t => t.Id == Titles.Equipped)?.Name;
        public List<TitleInfo> Unlocked => Titles?.Titles.Where(t => t.Unlocked).ToList() ?? new List<TitleInfo>();
        public List<TitleInfo> Locked => Titles?.Titles.Where(t => !t.Unlocked).ToList() ?? new List<TitleInfo>();
        /// <summary>"12/26".</summary>
        public string CountText => Titles == null ? null : Unlocked.Count + "/" + Titles.Titles.Count;

        /// <summary>Hint for a locked title: achievement titles name their tier; record titles their condition stays on the server.</summary>
        public string HintFor(TitleInfo t, AchievementList achievements = null)
        {
            if (t == null || t.Unlocked) return null;
            if (!t.FromAchievement) return "記録で獲得";
            var a = achievements?.Achievements.FirstOrDefault(x => x.Id == t.AchievementId);
            return "実績「" + (a?.Name ?? t.AchievementId) + "」" + t.Tier + "段で獲得";
        }

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Titles = null; return Offline("称号はオンラインで表示されます"); }
            try { Titles = await B.Api.GetTitlesAsync(ct); Online = true; return ActionResult.Success(); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Equip an unlocked title (null = none). The profile and the stable plate show it.</summary>
        public async Task<ActionResult> EquipAsync(string titleId, CancellationToken ct = default)
        {
            if (Titles == null || !ServerAvailable) return Offline("称号はオンラインで変更できます");
            if (titleId != null && !Unlocked.Any(t => t.Id == titleId)) return ActionResult.Error(UxText.Errors["NOT_ELIGIBLE"]);
            try
            {
                Titles.Equipped = await B.Api.EquipTitleAsync(titleId, ct);
                await B.RefreshAsync(ct);
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }
    }
}
