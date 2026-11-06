using System.Collections.Generic;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-ITEM-*: tickets, breeding material allowance and the cosmetics shop (server/master/items.json).

    /// <summary>Equipped cosmetics: tack per slot ("bridle", "saddlecloth") and stable decor slots (null = empty).</summary>
    public sealed class Equipment
    {
        public Dictionary<string, string> Tack = new Dictionary<string, string>();
        public List<string> Decor = new List<string>();

        internal static Equipment Parse(JsonNode o)
        {
            var e = new Equipment();
            if (o == null) return e;
            var t = J.Opt(o, "tack");
            if (t != null && t.Kind == JsonKind.Object) foreach (var kv in t.Props) if (kv.Value.Kind == JsonKind.String) e.Tack[kv.Key] = kv.Value.AsString();
            var d = J.Opt(o, "decor");
            if (d != null && d.Kind == JsonKind.Array) foreach (var x in d.Items) e.Decor.Add(x.IsNull ? null : x.AsString());
            return e;
        }
    }

    /// <summary>Changes to equipment. Leave a slot out to keep it; set <see cref="ClearTack"/> to unequip.</summary>
    public sealed class EquipmentPatch
    {
        public Dictionary<string, string> Tack;
        public List<string> ClearTack;
        /// <summary>Full replacement of the decor slots (null entries = empty slot); null = unchanged.</summary>
        public List<string> Decor;

        internal JsonNode ToJson()
        {
            var b = JsonNode.Obj();
            if (Tack != null || ClearTack != null)
            {
                var t = JsonNode.Obj();
                if (Tack != null) foreach (var kv in Tack) t.Set(kv.Key, kv.Value);
                if (ClearTack != null) foreach (var slot in ClearTack) t.Set(slot, JsonNode.Null());
                b.Set("tack", t);
            }
            if (Decor != null)
            {
                var a = JsonNode.Arr();
                foreach (var x in Decor) a.Add(x == null ? JsonNode.Null() : JsonNode.Str(x));
                b.Set("decor", a);
            }
            return b;
        }
    }

    public sealed class CosmeticItem
    {
        /// <summary>Kind: "silks" (unlocks a pattern), "tack" (Slot = bridle/saddlecloth) or "decor".</summary>
        public string Id, Name, Kind, Slot, Pattern, Currency, Icon, Asset;
        public int Price;
        public bool Owned, Equipped;
        public bool PaidOnly => Currency == "paidOnly";
        internal static CosmeticItem Parse(JsonNode o) => new CosmeticItem
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Kind = J.Str(o, "kind"), Slot = J.Str(o, "slot"), Pattern = J.Str(o, "pattern"),
            Currency = J.Str(o, "currency"), Icon = J.Str(o, "icon"), Asset = J.Str(o, "asset"), Price = J.Int(o, "price"),
            Owned = J.Bool(o, "owned"), Equipped = J.Bool(o, "equipped"),
        };
    }

    public sealed class CosmeticsCatalog
    {
        public int DecorSlots;
        public string Notice, SilksPattern;
        public Equipment Equipment = new Equipment();
        public List<CosmeticItem> Items = new List<CosmeticItem>();
        internal static CosmeticsCatalog Parse(JsonNode o) => new CosmeticsCatalog
        {
            DecorSlots = J.Int(o, "decorSlots"), Notice = J.Str(o, "notice"), SilksPattern = J.Str(o, "silksPattern"),
            Equipment = Equipment.Parse(J.Opt(o, "equipment")), Items = J.List(o, "items", CosmeticItem.Parse),
        };
    }

    public sealed class CosmeticPurchase
    {
        public string ItemId;
        public int SpentPaid, SpentFree;
        public Wallet Wallet;
        internal static CosmeticPurchase Parse(JsonNode o)
        {
            var sp = J.Opt(o, "spent");
            return new CosmeticPurchase { ItemId = J.Str(o, "itemId"), SpentPaid = J.Int(sp, "paid"), SpentFree = J.Int(sp, "free"), Wallet = Wallet.Parse(J.Opt(o, "wallet")) };
        }
    }

    /// <summary>A ticket's disclosure: "single" tickets name their banners (same table as the banner); "srPlus" lists its own table.</summary>
    public sealed class TicketInfo
    {
        public string ItemId, Name, Kind, Icon, Notice;
        public List<string> Banners = new List<string>();
        /// <summary>SR+ tickets only: the ticket's own table (display verbatim, like <see cref="OddsDisclosure"/>).</summary>
        public List<OddsRow> Items = new List<OddsRow>();
        public Dictionary<string, RarityTotal> RarityTotals = new Dictionary<string, RarityTotal>();
        internal static TicketInfo Parse(JsonNode o) => new TicketInfo
        {
            ItemId = J.Str(o, "itemId"), Name = J.Str(o, "name"), Kind = J.Str(o, "kind"), Icon = J.Str(o, "icon"), Notice = J.Str(o, "notice"),
            Banners = J.List(o, "banners", x => x.AsString()), Items = J.List(o, "items", OddsRow.Parse),
            RarityTotals = J.Opt(o, "rarityTotals") == null ? new Dictionary<string, RarityTotal>() : J.Map(o, "rarityTotals", RarityTotal.Parse),
        };
    }

    public sealed class TicketResult
    {
        public string ItemId, BannerId;
        public PullResult Result;
        /// <summary>Pity after a gacha-ticket draw; null for SR+ tickets (they add no pity).</summary>
        public int? PityPoints;
        public int Remaining;
        internal static TicketResult Parse(JsonNode o) => new TicketResult
        {
            ItemId = J.Str(o, "itemId"), BannerId = J.Str(o, "bannerId"), Result = PullResult.Parse(J.Opt(o, "result")),
            PityPoints = J.IntN(o, "pityPoints"), Remaining = J.Int(o, "remaining"),
        };
    }

    /// <summary>Today's breeding allowance (normal + extra breedings bought with breeding material).</summary>
    public sealed class BreedingAllowance
    {
        public int PerDay, Used, ExtraPerDay, ExtraUsed, MaterialCost, MaterialOwned;
        public string MaterialItemId;
        public int NormalLeft => System.Math.Max(0, PerDay - Used);
        public int ExtraLeft => System.Math.Max(0, ExtraPerDay - ExtraUsed);
        public bool CanBreedWithMaterial => NormalLeft == 0 && ExtraLeft > 0 && MaterialOwned >= MaterialCost;
        internal static BreedingAllowance Parse(JsonNode o) => o == null ? null : new BreedingAllowance
        {
            PerDay = J.Int(o, "perDay"), Used = J.Int(o, "used"), ExtraPerDay = J.Int(o, "extraPerDay"), ExtraUsed = J.Int(o, "extraUsed"),
            MaterialCost = J.Int(o, "materialCost"), MaterialOwned = J.Int(o, "materialOwned"), MaterialItemId = J.Str(o, "materialItemId"),
        };
    }
}
