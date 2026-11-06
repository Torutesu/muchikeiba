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

        /// <summary>Retired stallions/mares from the stable, plus friends' and public stud listings when online.</summary>
        public async Task LoadAsync(CancellationToken ct = default)
        {
            Online = false; Message = null; Preview = null; Offer = null; Foal = null; Sire = null; Dam = null;
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

        public void SelectSire(string key) { Sire = Sires.FirstOrDefault(s => s.Key == key); Preview = null; Offer = null; Foal = null; }
        public void SelectDam(string horseId) { Dam = Dams.FirstOrDefault(h => h.Id == horseId); Preview = null; Offer = null; Foal = null; }

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
                    Foal = r.Foal; LastAtavism = r.Atavism; LastFeeStatus = null;
                }
                Kv.Set(slot, null);
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
