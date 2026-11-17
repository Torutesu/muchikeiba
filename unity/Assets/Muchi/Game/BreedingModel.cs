using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>A stallion choice on the breeding screen: one of my retired stallions, or a friend's/public stud listing.</summary>
    public sealed class SireChoice
    {
        public string Key, HorseId, Name, Rarity, Line, Style, OwnerName;
        /// <summary>Null for my own stallion.</summary>
        public StudListing Stud;
        public bool IsStud => Stud != null;
        /// <summary>Stud fee in free coins (0 for my own stallion).</summary>
        public int Fee => Stud?.Fee ?? 0;
        public Appearance Appearance = new Appearance();
    }

    /// <summary>
    /// Breeding screen (frontend/design/screens/14-breeding.svg: 父馬と母馬を選ぶ → 血統と相性を確認する → 新しい相棒を迎える),
    /// including stallions borrowed from friends or the public stud list (REQ-BREED-010..016), atavism odds (REQ-BREED-018)
    /// and today's allowance. The idempotency key of a pending breeding is kept on the device until the server answers
    /// definitely, so a retry after a timeout or app restart never breeds (or pays a stud fee) twice.
    /// </summary>
    public sealed class BreedingModel : ScreenModel
    {
        public const string KeyPending = "muchi.breeding.pending";

        public List<SireChoice> Sires = new List<SireChoice>();
        public List<Horse> Dams = new List<Horse>();
        public SireChoice Sire;
        public Horse Dam;
        /// <summary>Preview of the selected pair (own or stud; the stud offer is in <see cref="Offer"/>).</summary>
        public BreedingPreview Preview;
        public StudOffer Offer;
        public Horse Foal;
        public AtavismTrait LastAtavism;
        /// <summary>"pending" right after a stud breeding whose fee the owner has not confirmed yet (server retries).</summary>
        public string LastFeeStatus;
        public StudMine Mine;
        /// <summary>REQ-ITEM-011 (quality pass 3): today's allowance after the last breeding (own pair), so the reveal can offer one more.</summary>
        public BreedingAllowance LastToday;
        /// <summary>The reveal's 「配合素材を1個使って、もう1回（残り 6個）」 when today's breeding is used and material allows one more; else null.</summary>
        public string AgainWithMaterialLine => LastToday != null && LastToday.CanBreedWithMaterial
            ? "配合素材を" + LastToday.MaterialCost.ToString(CultureInfo.InvariantCulture) + "個使って、もう1回（残り " + LastToday.MaterialOwned.ToString(CultureInfo.InvariantCulture) + "個）" : null;

        public BreedingModel(GameBackend backend, IKeyValueStore store) : base(backend, store) { }

        /// <summary>Design step: 0 = choose parents, 1 = check pedigree/compatibility, 2 = welcome the foal.</summary>
        public int Step => Foal != null ? 2 : Sire != null && Dam != null && Preview != null ? 1 : 0;
        public bool CanBreed => ServerAvailable && Sire != null && Dam != null && Preview != null && (Offer == null || Offer.CanPay) && (NormalLeft > 0 || CanUseMaterial);
        public int NormalLeft => Preview?.Today == null ? 0 : Math.Max(0, Preview.Today.PerDay - Preview.Today.Used);
        public bool CanUseMaterial => Preview?.Today != null && Preview.Today.CanBreedWithMaterial;
        public string CompatibilityLabel => Preview == null ? "" : (Preview.Nick ? "◎ ニックス" : "○ 通常") + (Preview.InbreedingCount > 0 ? "  /  近親 " + Preview.InbreedingCount + "（能力 −" + Preview.InbreedingCount * 50 + "）" : "");
        /// <summary>"種付け料 ◎50（無償コインのみ）" for a stud, null for my own stallion.</summary>
        public string FeeLine => Offer == null ? null : Offer.Fee == 0 ? "種付け料 無料" : "種付け料 ◎" + Offer.Fee + "（無償コインのみ）" + (Offer.CanPay ? "" : "  /  無償コインが足りません");

        /// <summary>Shown under the fee when purchase-bonus free coins are held back from stud fees (stud.heldFree &gt; 0), else null.</summary>
        public string HeldFreeNote => Offer == null || Offer.HeldFree <= 0 ? null
            : "購入特典の無償コインは90日間 種付け料に使えません（◎" + Offer.HeldFree.ToString(CultureInfo.InvariantCulture) + "）";

        /// <summary>One line per atavism candidate: "隔世遺伝 1.333%  逃げ ← ハツユキソウ". Same odds as the real breeding.</summary>
        public List<string> AtavismLines()
        {
            var a = Preview?.Atavism;
            if (a == null || a.Candidates.Count == 0) return new List<string>();
            return a.Candidates.Select(c => "隔世遺伝 " + Percent(c.PerMillion) + "  " + TraitLabel(c.Trait) + " ← " + c.Trait.From).ToList();
        }

        public static string Percent(long perMillion) => (perMillion / 10000).ToString(CultureInfo.InvariantCulture) + "." + (perMillion % 10000 / 10).ToString("000", CultureInfo.InvariantCulture) + "%";

        public static string TraitLabel(AtavismTrait t)
        {
            if (t == null) return "";
            if (t.Trait == "style") return t.Value switch { "nige" => "逃げ", "senko" => "先行", "sashi" => "差し", "oikomi" => "追込", _ => t.Value };
            return t.Value switch { "heavy" => "重馬場巧者", "fast" => "良馬場巧者", _ => "馬場不問" };
        }

        // ---- quality pass (docs/quality/raising-breeding.md, protocol Q1): intent before, a reveal after. Odds are the server's
        // (the preview's own fields; the rarity odds are exact from the breeding rules). Nothing here draws or invents a chance.

        /// <summary>"仔のレア度の見込み　SSR 1.2%・SR 20.5%・R 78.3%", or null on older servers.</summary>
        public string RarityLine => Preview?.Rarity == null || !Preview.Rarity.Known ? null
            : "仔のレア度の見込み　SSR " + FoalRarityOdds.Percent(Preview.Rarity.SSR) + "・SR " + FoalRarityOdds.Percent(Preview.Rarity.SR) + "・R " + FoalRarityOdds.Percent(Preview.Rarity.R);

        /// <summary>
        /// What one parent can pass on, one line each, from the preview: its running style (the share the preview gives it) and its
        /// unique skill (the inherit chance). <paramref name="who"/> = "sire" | "dam". 隔世遺伝 candidates are in <see cref="AtavismLines"/>.
        /// </summary>
        public List<string> ParentGifts(string who)
        {
            var lines = new List<string>();
            if (Preview == null || Sire == null || Dam == null) return lines;
            string style = who == "sire" ? Sire.Style : Dam.Style;
            if (style != null && Preview.StyleMilliPercent.TryGetValue(style, out var sp))
                lines.Add("脚質 " + TraitLabel(new AtavismTrait { Trait = "style", Value = style }) + " " + Milli(sp));
            foreach (var c in Preview.Skill.Candidates.Where(c => c.From.Contains(who)))
                lines.Add("固有スキル「" + c.Skill?.Name + "」 " + Percent(c.Permille * 1000L / Math.Max(1, c.From.Length)));
            return lines;
        }

        private static string Milli(long milliPercent) => (milliPercent / 1000).ToString(CultureInfo.InvariantCulture) + (milliPercent % 1000 == 0 ? "" : "." + (milliPercent % 1000 / 100).ToString(CultureInfo.InvariantCulture)) + "%";

        /// <summary>The foal reveal after a breeding (null before). Steps: <see cref="FoalReveal.Steps"/>.</summary>
        public FoalReveal Reveal { get; private set; }
        /// <summary>How many reveal steps are uncovered (0..4). The screen advances it on a tap; "すべて見る" jumps to the end.</summary>
        public int RevealStep { get; private set; }
        public bool RevealDone => Reveal != null && RevealStep >= FoalReveal.Steps.Length;
        public void NextRevealStep() { if (Reveal != null && RevealStep < FoalReveal.Steps.Length) RevealStep++; }
        public void RevealAll() { if (Reveal != null) RevealStep = FoalReveal.Steps.Length; }

        /// <summary>"期待以上が2つ" / "見込みどおり" — how the five stats landed in the preview's range.</summary>
        public string RevealVerdict => Reveal == null ? null : Reveal.HighCount > 0 ? "期待以上が" + Reveal.HighCount.ToString(CultureInfo.InvariantCulture) + "つ" : "見込みどおり";
        /// <summary>"SR（見込み 20.5%）" — the rarity and the chance the preview gave it.</summary>
        public string RevealRarityText => Reveal == null ? null : Reveal.Foal.Rarity + (Reveal.RarityChancePpm >= 0 ? "（見込み " + FoalRarityOdds.Percent(Reveal.RarityChancePpm) + "）" : "");
        /// <summary>"脚質 差し：父から" / "脚質 逃げ：隔世遺伝".</summary>
        public string RevealStyleText => Reveal == null ? null : "脚質 " + TraitLabel(new AtavismTrait { Trait = "style", Value = Reveal.Foal.Style }) + "：" + StyleFromText(Reveal.StyleFrom);
        public static string StyleFromText(string from) => from switch { "sire" => "父から", "dam" => "母から", "both" => "父と母から", "atavism" => "隔世遺伝", _ => "新しい脚質" };

        // ---- U1 raising screens (docs/quality/unity-raising.md): the lines the Unity breeding screen and foal reveal draw. Every
        // number is the server's preview / breeding answer; nothing here invents a chance.

        /// <summary>Each candidate's preview against the other chosen parent ("sire:" + key / "dam:" + horse id), from <see cref="LoadAimsAsync"/>.</summary>
        public Dictionary<string, BreedingPreview> Aims = new Dictionary<string, BreedingPreview>();

        /// <summary>
        /// The aim on each parent card (the prototype's qr-aim): previews the first <paramref name="max"/> sires against the chosen dam
        /// and the first dams against the chosen sire. A failed preview leaves that card without an aim line (it is a hint, not a gate).
        /// </summary>
        public async Task LoadAimsAsync(int max = 3, CancellationToken ct = default)
        {
            Aims = new Dictionary<string, BreedingPreview>();
            if (!ServerAvailable) return;
            async Task<BreedingPreview> Of(SireChoice sire, Horse dam)
            {
                try
                {
                    if (sire.IsStud) return (await B.Api.StudPreviewAsync(sire.Stud.OwnerId, sire.HorseId, dam.Id, ct)).Breeding;
                    return await B.Api.BreedingPreviewAsync(sire.HorseId, dam.Id, ct);
                }
                catch (ApiException) { return null; }
            }
            if (Dam != null)
                foreach (var c in Sires.Take(max)) { var p = c == Sire && Preview != null ? Preview : await Of(c, Dam); if (p != null) Aims["sire:" + c.Key] = p; }
            if (Sire != null)
                foreach (var d in Dams.Take(max)) { var p = d == Dam && Preview != null ? Preview : await Of(Sire, d); if (p != null) Aims["dam:" + d.Id] = p; }
        }

        /// <summary>"SR以上 22.0%　·　◎ ニックス　·　近親" for a candidate card; null without an aim.</summary>
        public string AimLine(string who, string key) => key != null && Aims.TryGetValue(who + ":" + key, out var p) ? AimText(p) : null;

        public static string AimText(BreedingPreview p)
        {
            if (p?.Rarity == null || !p.Rarity.Known) return null;
            return "SR以上 " + FoalRarityOdds.Percent(p.Rarity.SR + p.Rarity.SSR) + (p.Nick ? "　·　◎ ニックス" : "") + (p.InbreedingCount > 0 ? "　·　近親" : "");
        }

        /// <summary>True when a candidate's aim is worth the gold accent (some SR-or-better chance, or a nick).</summary>
        public bool AimIsUp(string who, string key) => key != null && Aims.TryGetValue(who + ":" + key, out var p) && p?.Rarity != null && (p.Rarity.SR + p.Rarity.SSR > 0 || p.Nick);

        /// <summary>"今日あと1回" / "配合素材を1個使って、もう1回" / "今日の配合はおしまい。4:00に戻ります" (null before a preview).</summary>
        public string TodayLine => Preview?.Today == null ? null : NormalLeft > 0 ? "今日あと" + NormalLeft.ToString(CultureInfo.InvariantCulture) + "回"
            : CanUseMaterial ? "配合素材を" + Preview.Today.MaterialCost.ToString(CultureInfo.InvariantCulture) + "個使って、もう1回" : "今日の配合はおしまい。4:00に戻ります";

        /// <summary>"SSR 1.5%　·　SR 20.5%　·　R 78.0%" under the stacked bar (null on older servers).</summary>
        public string RarityOddsText => Preview?.Rarity == null || !Preview.Rarity.Known ? null
            : "SSR " + FoalRarityOdds.Percent(Preview.Rarity.SSR) + "　·　SR " + FoalRarityOdds.Percent(Preview.Rarity.SR) + "　·　R " + FoalRarityOdds.Percent(Preview.Rarity.R);

        /// <summary>"◎ ニックス（相性がよい）" / "○ 通常の相性　·　近親 1（能力 −50）".</summary>
        public string CompatibilityText => Preview == null ? null
            : (Preview.Nick ? "◎ ニックス（相性がよい）" : "○ 通常の相性") + (Preview.InbreedingCount > 0 ? "　·　近親 " + Preview.InbreedingCount + "（能力 −" + Preview.InbreedingCount * 50 + "）" : "");

        /// <summary>"距離 1,400〜2,400m　·　芝".</summary>
        public string DistanceText => Preview == null ? null
            : "距離 " + Preview.DistanceMinM.ToString("N0", CultureInfo.InvariantCulture) + "〜" + Preview.DistanceMaxM.ToString("N0", CultureInfo.InvariantCulture) + "m　·　"
              + (Preview.Surface == "turf" ? "芝" : Preview.Surface == "dirt" ? "ダート" : "芝・ダートのどちらか");

        /// <summary>Reveal step 1: "牝馬　·　脚質 差し：父から".</summary>
        public string RevealSexStyleText => Reveal == null ? null : (Reveal.Foal.Sex == "female" ? "牝馬" : "牡馬") + "　·　" + RevealStyleText;
        /// <summary>Reveal step 3: "期待以上が2つ　·　能力合計 3,320　·　見込み 20.5%".</summary>
        public string RevealSummaryText => Reveal == null ? null
            : RevealVerdict + "　·　能力合計 " + Reveal.Total.ToString("N0", CultureInfo.InvariantCulture) + (Reveal.RarityChancePpm >= 0 ? "　·　見込み " + FoalRarityOdds.Percent(Reveal.RarityChancePpm) : "");
        /// <summary>Reveal step 4: "固有スキル「末脚一閃」を母から受け継ぎました" (null with no skill).</summary>
        public string RevealSkillText
        {
            get
            {
                if (Reveal?.SkillFrom == null || Preview?.Skill == null) return null;
                var c = Preview.Skill.Candidates.FirstOrDefault(x => x.Skill?.Id == Reveal.Foal.SkillId);
                return c == null ? null : "固有スキル「" + c.Skill.Name + "」を" + StyleFromText(Reveal.SkillFrom) + "受け継ぎました";
            }
        }
        /// <summary>Reveal step 4: "隔世遺伝：逃げ（ハツユキソウ）" (null without one).</summary>
        public string RevealAtavismText => Reveal?.Atavism == null ? null : "隔世遺伝：" + TraitLabel(Reveal.Atavism) + "（" + Reveal.Atavism.From + "）";
        /// <summary>Reveal step 4: "父 アカツキ　·　母 サクラ" (names as typed).</summary>
        public string RevealParentsText => Reveal == null || Sire == null || Dam == null ? null : "父 " + Sire.Name + "　·　母 " + Dam.Name;

        /// <summary>Retired stallions/mares from the stable, plus friends' and public stud listings when online.</summary>
        public async Task LoadAsync(CancellationToken ct = default)
        {
            Online = false; Message = null; Preview = null; Offer = null; Foal = null; Sire = null; Dam = null; Reveal = null; RevealStep = 0;
            var horses = B.Player?.Horses ?? new List<Horse>();
            Dams = horses.Where(h => h.IsRetired && h.Sex == "female").ToList();
            Sires = horses.Where(h => h.IsRetired && h.Sex == "male").Select(h => new SireChoice
            {
                Key = "own:" + h.Id, HorseId = h.Id, Name = h.Name, Rarity = h.Rarity, Line = h.Line, Style = h.Style, Appearance = h.Appearance,
            }).ToList();
            if (!ServerAvailable) { Message = "OFFLINE  /  breeding runs on the server"; return; }
            try
            {
                var seen = new HashSet<string>();
                foreach (var scope in new[] { "friends", "public" })
                {
                    var b = await B.Api.BrowseStudAsync(scope, ct);
                    foreach (var l in b.Listings)
                        if (seen.Add(l.OwnerId + "/" + l.HorseId))
                            Sires.Add(new SireChoice { Key = "stud:" + l.OwnerId + "/" + l.HorseId, HorseId = l.HorseId, Name = l.Name, Rarity = l.Rarity, Line = l.Line, Style = l.Style, OwnerName = l.OwnerName, Stud = l, Appearance = l.Appearance });
                }
                Mine = await B.Api.GetMyStudAsync(ct);
                Online = true;
            }
            catch (ApiException e) { Fail(e); Online = e.Status == 404; } // 404: stud lending switched off; own breeding still works
        }

        public void SelectSire(string key) { Sire = Sires.FirstOrDefault(s => s.Key == key); Preview = null; Offer = null; Foal = null; Reveal = null; RevealStep = 0; }
        public void SelectDam(string horseId) { Dam = Dams.FirstOrDefault(h => h.Id == horseId); Preview = null; Offer = null; Foal = null; Reveal = null; RevealStep = 0; }

        public async Task<ActionResult> PreviewAsync(CancellationToken ct = default)
        {
            if (Sire == null || Dam == null) return ActionResult.Error("父馬と母馬を選んでください");
            if (!ServerAvailable) return Offline("breeding runs on the server");
            try
            {
                if (Sire.IsStud)
                {
                    var p = await B.Api.StudPreviewAsync(Sire.Stud.OwnerId, Sire.HorseId, Dam.Id, ct);
                    Preview = p.Breeding; Offer = p.Stud;
                }
                else { Preview = await B.Api.BreedingPreviewAsync(Sire.HorseId, Dam.Id, ct); Offer = null; }
                Message = CompatibilityLabel;
                return ActionResult.Success(Message);
            }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>Breed the selected pair. <paramref name="useMaterial"/> = an extra breeding paid with breeding material.</summary>
        public async Task<ActionResult> BreedAsync(bool useMaterial = false, CancellationToken ct = default)
        {
            if (Sire == null || Dam == null) return ActionResult.Error("父馬と母馬を選んでください");
            if (!ServerAvailable) return Offline("breeding runs on the server");
            string slot = KeyPending + ":" + Sire.Key + ":" + Dam.Id;
            string key = Kv.Get(slot);
            if (string.IsNullOrEmpty(key)) { key = B.Api.NewIdempotencyKey(); Kv.Set(slot, key); }
            try
            {
                if (Sire.IsStud)
                {
                    // the fee the player agreed to in the preview: the server refuses (FEE_CHANGED) if the owner changed it since
                    var r = await B.Api.StudBreedAsync(Sire.Stud.OwnerId, Sire.HorseId, Dam.Id, key, ct, useMaterial, Offer?.Fee);
                    Foal = r.Foal; LastAtavism = r.Atavism; LastFeeStatus = r.FeeStatus;
                }
                else
                {
                    var r = await B.Api.BreedAsync(Sire.HorseId, Dam.Id, key, ct, useMaterial);
                    Foal = r.Foal; LastAtavism = r.Atavism; LastFeeStatus = null; LastToday = r.Today;
                }
                Kv.Set(slot, null);
                Reveal = Foal == null ? null : FoalReveal.Build(Preview, Foal, Sire.Style, Dam.Style);
                RevealStep = 0;
                await B.RefreshAsync(ct);
                Message = "新しい相棒が生まれました" + (LastAtavism != null ? "  /  隔世遺伝: " + TraitLabel(LastAtavism) + "（" + LastAtavism.From + "）" : "")
                    + (LastFeeStatus == "pending" ? "  /  種付け料は確認中です" : "");
                return ActionResult.Success(Message);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e)
            {
                if (ItemsBackend.IsDefiniteRejection(e)) Kv.Set(slot, null);
                if (e.WireCode == FeeChanged)
                {
                    // nothing was charged: drop the key and the stale offer so the player previews the new fee first
                    Kv.Set(slot, null);
                    Preview = null; Offer = null;
                    Message = FeeChangedMessage;
                    return ActionResult.Error(Message);
                }
                return Fail(e);
            }
        }

        /// <summary>Server code when the stud fee differs from the previewed one (the owner changed it meanwhile).</summary>
        public const string FeeChanged = "FEE_CHANGED";
        public const string FeeChangedMessage = "種付け料が変更されました。もう一度確認してください";

        /// <summary>Offer one of my retired stallions (fee in free coins, 0..FeeMax).</summary>
        public async Task<ActionResult> ListMyStallionAsync(string horseId, bool publicListing, int fee, int dailyLimit, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("stud listings are kept on the server");
            try
            {
                await B.Api.ListStudAsync(horseId, publicListing ? "public" : "friends", fee, dailyLimit, ct);
                Mine = await B.Api.GetMyStudAsync(ct);
                return ActionResult.Success(Message = "種牡馬として登録しました");
            }
            catch (ApiException e) { return Fail(e); }
        }

        public async Task<ActionResult> UnlistMyStallionAsync(string horseId, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("stud listings are kept on the server");
            try
            {
                await B.Api.UnlistStudAsync(horseId, ct);
                Mine = await B.Api.GetMyStudAsync(ct);
                return ActionResult.Success(Message = "登録を取り下げました");
            }
            catch (NotFoundException)
            {
                // a retry after a lost reply: the listing is already gone, which is what the player asked for
                try
                {
                    Mine = await B.Api.GetMyStudAsync(ct);
                    if (Mine.Listings.Any(l => l.HorseId == horseId)) return ActionResult.Error(Message = "登録を取り下げられませんでした");
                }
                catch (ApiException e) { return Fail(e); }
                return ActionResult.Success(Message = "登録を取り下げました");
            }
            catch (ApiException e) { return Fail(e); }
        }
    }
}
