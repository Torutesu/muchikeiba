using System;
using System.Collections.Generic;
using System.Globalization;
using Muchi.Net;

namespace Muchi.Client
{
    /// <summary>Lenient JSON readers for API responses (missing/null optional fields become defaults).</summary>
    internal static class J
    {
        public static JsonNode Opt(JsonNode o, string k) => o != null && o.Kind == JsonKind.Object && o.TryGet(k, out var v) && !v.IsNull ? v : null;
        public static string Str(JsonNode o, string k) { var v = Opt(o, k); return v == null ? null : v.Kind == JsonKind.String ? v.AsString() : v.ToString(); }
        public static int Int(JsonNode o, string k, int def = 0) { var v = Opt(o, k); return v == null ? def : v.AsInt(); }
        public static int? IntN(JsonNode o, string k) { var v = Opt(o, k); return v == null ? (int?)null : v.AsInt(); }
        public static long Long(JsonNode o, string k, long def = 0) { var v = Opt(o, k); return v == null ? def : v.AsLong(); }
        public static long? LongN(JsonNode o, string k) { var v = Opt(o, k); return v == null ? (long?)null : v.AsLong(); }
        public static bool Bool(JsonNode o, string k) { var v = Opt(o, k); return v != null && v.AsBool(); }

        public static List<T> List<T>(JsonNode o, string k, Func<JsonNode, T> f)
        {
            var list = new List<T>();
            var v = Opt(o, k);
            if (v == null) return list;
            foreach (var it in v.Items) list.Add(f(it));
            return list;
        }

        public static Dictionary<string, T> Map<T>(JsonNode o, string k, Func<JsonNode, T> f)
        {
            var d = new Dictionary<string, T>();
            var v = Opt(o, k);
            if (v == null) return d;
            foreach (var kv in v.Props) if (!kv.Value.IsNull) d[kv.Key] = f(kv.Value);
            return d;
        }

        public static int[] Ints(JsonNode o, string k)
        {
            var v = Opt(o, k);
            if (v == null) return new int[0];
            var a = new int[v.Count];
            for (int i = 0; i < a.Length; i++) a[i] = v[i].AsInt();
            return a;
        }

        public static string[] Strs(JsonNode o, string k)
        {
            var v = Opt(o, k);
            if (v == null) return new string[0];
            var a = new string[v.Count];
            for (int i = 0; i < a.Length; i++) a[i] = v[i].AsString();
            return a;
        }

        /// <summary>Parses a decimal JSON number into thousandths without using floating point ("47.5" → 47500).</summary>
        public static long Milli(JsonNode v)
        {
            string s = v.NumberText;
            bool neg = s.StartsWith("-", StringComparison.Ordinal);
            if (neg) s = s.Substring(1);
            int e = s.IndexOfAny(new[] { 'e', 'E' });
            if (e >= 0) throw new FormatException("exponent not supported: " + s);
            int dot = s.IndexOf('.');
            string ip = dot < 0 ? s : s.Substring(0, dot);
            string fp = dot < 0 ? "" : s.Substring(dot + 1);
            if (fp.Length > 3) fp = fp.Substring(0, 3);
            while (fp.Length < 3) fp += "0";
            long r = long.Parse(ip.Length == 0 ? "0" : ip, CultureInfo.InvariantCulture) * 1000 + long.Parse(fp, CultureInfo.InvariantCulture);
            return neg ? -r : r;
        }
    }

    public sealed class Stats
    {
        public int Speed, Stamina, Burst, Guts, Temper;
        internal static Stats Parse(JsonNode o) => o == null ? new Stats() : new Stats
        {
            Speed = J.Int(o, "speed"), Stamina = J.Int(o, "stamina"), Burst = J.Int(o, "burst"), Guts = J.Int(o, "guts"), Temper = J.Int(o, "temper"),
        };
    }

    public sealed class Wallet
    {
        public int Paid, Free, Total, Debt;
        internal static Wallet Parse(JsonNode o) => o == null ? null : new Wallet { Paid = J.Int(o, "paid"), Free = J.Int(o, "free"), Total = J.Int(o, "total"), Debt = J.Int(o, "debt") };
    }

    /// <summary>A horse the player owns (server PlayerState.horses[]).</summary>
    public sealed class Horse
    {
        public string Id, TemplateId, Name, Rarity, Sex, Style, Surface, Line, Status, SireId, DamId, SireName, DamName;
        public int DistMinM, DistMaxM, Awakening;
        public long BornAt;
        public bool Named;
        public Stats Base;
        public bool IsActive => Status == "active";
        public bool IsRetired => Status == "retired";

        internal static Horse Parse(JsonNode o) => new Horse
        {
            Id = J.Str(o, "id"), TemplateId = J.Str(o, "templateId"), Name = J.Str(o, "name"), Rarity = J.Str(o, "rarity"),
            Sex = J.Str(o, "sex"), Style = J.Str(o, "style"), Surface = J.Str(o, "surface"), Line = J.Str(o, "line"),
            Status = J.Str(o, "status"), SireId = J.Str(o, "sireId"), DamId = J.Str(o, "damId"),
            SireName = J.Str(o, "sireName"), DamName = J.Str(o, "damName"),
            DistMinM = J.Int(o, "distMinM"), DistMaxM = J.Int(o, "distMaxM"), Awakening = J.Int(o, "awakening"),
            BornAt = J.Long(o, "bornAt"), Named = J.Bool(o, "named"), Base = Stats.Parse(J.Opt(o, "base")),
        };
    }

    public sealed class ItemQty
    {
        public string ItemId;
        public int Qty;
        internal static ItemQty Parse(JsonNode o) => new ItemQty { ItemId = J.Str(o, "itemId"), Qty = J.Int(o, "qty") };
    }

    public sealed class Reward
    {
        public int FreeCoins;
        public List<ItemQty> Items = new List<ItemQty>();
        internal static Reward Parse(JsonNode o) => o == null ? new Reward() : new Reward { FreeCoins = J.Int(o, "freeCoins"), Items = J.List(o, "items", ItemQty.Parse) };
    }

    public sealed class SeasonPassState
    {
        public long ExpiresAt;
        public int Xp;
        public int[] ClaimedFree = new int[0], ClaimedPremium = new int[0];
        public string SeasonId;
        internal static SeasonPassState Parse(JsonNode o)
        {
            var c = J.Opt(o, "claimed");
            return new SeasonPassState { ExpiresAt = J.Long(o, "expiresAt"), Xp = J.Int(o, "xp"), ClaimedFree = J.Ints(c, "free"), ClaimedPremium = J.Ints(c, "premium"), SeasonId = J.Str(o, "seasonId") };
        }
    }

    public sealed class PlayerView
    {
        public string Id;
        public Wallet Wallet;
        public Dictionary<string, int> Items = new Dictionary<string, int>();
        public int AwakeningMaterial;
        public Dictionary<string, int> Pity = new Dictionary<string, int>();
        public List<Horse> Horses = new List<Horse>();
        public bool AgeRegistered;
        public bool TutorialGachaUsed;
        public SeasonPassState SeasonPass;
        public int LoginStreakDay;
        public string LoginLastClaimDate;
        public int Rating, RatingDeviation, RankedRaces;
        public string SeasonId, ClassId;
        public int SeasonPoints;

        internal static PlayerView Parse(JsonNode o)
        {
            var lb = J.Opt(o, "loginBonus");
            var r = J.Opt(o, "rating");
            var s = J.Opt(o, "season");
            return new PlayerView
            {
                Id = J.Str(o, "id"), Wallet = Wallet.Parse(J.Opt(o, "wallet")),
                Items = J.Map(o, "items", v => v.AsInt()), AwakeningMaterial = J.Int(J.Opt(o, "materials"), "awakening"),
                Pity = J.Map(o, "pity", v => v.AsInt()), Horses = J.List(o, "horses", Horse.Parse),
                AgeRegistered = J.Bool(o, "ageRegistered"), TutorialGachaUsed = J.Bool(J.Opt(o, "flags"), "tutorialGachaUsed"),
                SeasonPass = SeasonPassState.Parse(J.Opt(o, "seasonPass")),
                LoginStreakDay = J.Int(lb, "streakDay"), LoginLastClaimDate = J.Str(lb, "lastClaimDate"),
                Rating = J.Int(r, "r"), RatingDeviation = J.Int(r, "rd"), RankedRaces = J.Int(r, "rankedRaces"),
                SeasonId = J.Str(s, "id"), ClassId = J.Str(s, "classId"), SeasonPoints = J.Int(s, "points"),
            };
        }
    }

    public sealed class AgeResult
    {
        public int Age;
        public string Band;
        /// <summary>null = no monthly limit (20+).</summary>
        public int? MonthlyLimitYen;
        internal static AgeResult Parse(JsonNode o) => new AgeResult { Age = J.Int(o, "age"), Band = J.Str(o, "band"), MonthlyLimitYen = J.IntN(o, "monthlyLimitYen") };
    }

    public sealed class Product
    {
        public string Id, Kind;
        public int PriceYen, PaidCoins;
        public bool Once;
        public int? DurationDays;
        public List<ItemQty> Items = new List<ItemQty>();
        internal static Product Parse(JsonNode o) => new Product
        {
            Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), PriceYen = J.Int(o, "priceYen"), PaidCoins = J.Int(o, "paidCoins"),
            Once = J.Bool(o, "once"), DurationDays = J.IntN(o, "durationDays"), Items = J.List(o, "items", ItemQty.Parse),
        };
    }

    public sealed class ProductList
    {
        public List<Product> Products = new List<Product>();
        /// <summary>Shop notice to display (e.g. 有償コインから先に使われます).</summary>
        public string Notice;
        internal static ProductList Parse(JsonNode o) => new ProductList { Products = J.List(o, "products", Product.Parse), Notice = J.Str(o, "notice") };
    }

    public sealed class PurchaseIntent
    {
        public Product Product;
        public int MonthSpentYen;
        public int? MonthlyLimitYen, RemainingYen;
        internal static PurchaseIntent Parse(JsonNode o) => new PurchaseIntent
        {
            Product = Product.Parse(J.Opt(o, "product")), MonthSpentYen = J.Int(o, "monthSpentYen"),
            MonthlyLimitYen = J.IntN(o, "monthlyLimitYen"), RemainingYen = J.IntN(o, "remainingYen"),
        };
    }

    public sealed class PurchaseRecord
    {
        public string TxId, Platform, ProductId, LotId;
        public int PriceYen, PaidCoinsGranted, BonusCoinsGranted;
        public long At;
        public bool Refunded, LimitBreach;
        internal static PurchaseRecord Parse(JsonNode o) => new PurchaseRecord
        {
            TxId = J.Str(o, "txId"), Platform = J.Str(o, "platform"), ProductId = J.Str(o, "productId"), LotId = J.Str(o, "lotId"),
            PriceYen = J.Int(o, "priceYen"), PaidCoinsGranted = J.Int(o, "paidCoinsGranted"), BonusCoinsGranted = J.Int(o, "bonusCoinsGranted"),
            At = J.Long(o, "at"), Refunded = J.Bool(o, "refunded"), LimitBreach = J.Bool(o, "limitBreach"),
        };
    }

    public sealed class PurchaseResult
    {
        public PurchaseRecord Record;
        /// <summary>true when this transaction had already been granted (safe re-send after a crash).</summary>
        public bool Duplicate;
        public Wallet Wallet;
        internal static PurchaseResult Parse(JsonNode o) => new PurchaseResult { Record = PurchaseRecord.Parse(J.Opt(o, "record")), Duplicate = J.Bool(o, "duplicate"), Wallet = Wallet.Parse(J.Opt(o, "wallet")) };
    }

    public sealed class Banner
    {
        public string Id, Name, Currency;
        public int PriceSingle, PriceTen;
        public long? StartAtMs, EndAtMs;
        public bool PaidOnly => Currency == "paidOnly";
        internal static Banner Parse(JsonNode o) => new Banner
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Currency = J.Str(o, "currency"),
            PriceSingle = J.Int(o, "priceSingle"), PriceTen = J.Int(o, "priceTen"), StartAtMs = J.LongN(o, "startAtMs"), EndAtMs = J.LongN(o, "endAtMs"),
        };
    }

    public sealed class OddsRow
    {
        public string TemplateId, Name, Rarity;
        /// <summary>Parts per million (1,000,000 = 100%).</summary>
        public int Ppm;
        /// <summary>Display string generated by the server, e.g. "1.0000%". Show this as-is.</summary>
        public string Rate;
        internal static OddsRow Parse(JsonNode o) => new OddsRow { TemplateId = J.Str(o, "templateId"), Name = J.Str(o, "name"), Rarity = J.Str(o, "rarity"), Ppm = J.Int(o, "ppm"), Rate = J.Str(o, "rate") };
    }

    public sealed class RarityTotal
    {
        public int Ppm;
        public string Rate;
        internal static RarityTotal Parse(JsonNode o) => new RarityTotal { Ppm = J.Int(o, "ppm"), Rate = J.Str(o, "rate") };
    }

    /// <summary>Odds disclosure (REQ-GACHA-002). Generated by the server from the drawing table; display verbatim.</summary>
    public sealed class OddsDisclosure
    {
        public string BannerId, Name, Currency;
        public int PriceSingle, PriceTen;
        public List<OddsRow> Items = new List<OddsRow>();
        public Dictionary<string, RarityTotal> RarityTotals = new Dictionary<string, RarityTotal>();
        public string GuaranteeAppliesTo;
        public List<OddsRow> GuaranteeItems = new List<OddsRow>();
        public Dictionary<string, RarityTotal> GuaranteeRarityTotals = new Dictionary<string, RarityTotal>();
        public string PityGroup;
        public int PityPullsRequired, PityEstimatedMaxCostYen;
        public string[] PityTargets = new string[0];
        public Dictionary<string, int> DuplicateMaterial = new Dictionary<string, int>();

        internal static OddsDisclosure Parse(JsonNode o)
        {
            var g = J.Opt(o, "guarantee");
            var p = J.Opt(o, "pity");
            return new OddsDisclosure
            {
                BannerId = J.Str(o, "bannerId"), Name = J.Str(o, "name"), Currency = J.Str(o, "currency"),
                PriceSingle = J.Int(o, "priceSingle"), PriceTen = J.Int(o, "priceTen"),
                Items = J.List(o, "items", OddsRow.Parse), RarityTotals = J.Map(o, "rarityTotals", RarityTotal.Parse),
                GuaranteeAppliesTo = J.Str(g, "appliesTo"), GuaranteeItems = J.List(g, "items", OddsRow.Parse),
                GuaranteeRarityTotals = J.Map(g, "rarityTotals", RarityTotal.Parse),
                PityGroup = J.Str(p, "group"), PityPullsRequired = J.Int(p, "pullsRequired"), PityTargets = J.Strs(p, "targets"),
                PityEstimatedMaxCostYen = J.Int(p, "estimatedMaxCostYen"),
                DuplicateMaterial = J.Map(o, "duplicates", v => v.AsInt()),
            };
        }
    }

    public sealed class PullResult
    {
        public string TemplateId, Rarity;
        /// <summary>New horse id, or null for a duplicate (converted to awakening material).</summary>
        public string HorseId;
        public bool Duplicate, Guaranteed;
        public int Material;
        internal static PullResult Parse(JsonNode o) => new PullResult
        {
            TemplateId = J.Str(o, "templateId"), Rarity = J.Str(o, "rarity"), HorseId = J.Str(o, "horseId"),
            Duplicate = J.Bool(o, "duplicate"), Guaranteed = J.Bool(o, "guaranteed"), Material = J.Int(o, "material"),
        };
    }

    public sealed class DrawResult
    {
        public string BannerId;
        public List<PullResult> Results = new List<PullResult>();
        public int SpentPaid, SpentFree, PityPoints;
        /// <summary>Wallet after the draw (null for the free tutorial draw).</summary>
        public Wallet Wallet;
        internal static DrawResult Parse(JsonNode o)
        {
            var sp = J.Opt(o, "spent");
            return new DrawResult
            {
                BannerId = J.Str(o, "bannerId"), Results = J.List(o, "results", PullResult.Parse),
                SpentPaid = J.Int(sp, "paid"), SpentFree = J.Int(sp, "free"), PityPoints = J.Int(o, "pityPoints"), Wallet = Wallet.Parse(J.Opt(o, "wallet")),
            };
        }
    }

    public sealed class PedigreeNode
    {
        public string Key, Name, HorseId;
        public PedigreeNode Sire, Dam;
        internal static PedigreeNode Parse(JsonNode o) => o == null ? null : new PedigreeNode
        {
            Key = J.Str(o, "key"), Name = J.Str(o, "name"), HorseId = J.Str(o, "horseId"),
            Sire = Parse(J.Opt(o, "sire")), Dam = Parse(J.Opt(o, "dam")),
        };

        /// <summary>Number of known generations above this node (0 when no parents are known).</summary>
        public int GenerationsAbove => Sire == null && Dam == null ? 0 : 1 + Math.Max(Sire?.GenerationsAbove ?? 0, Dam?.GenerationsAbove ?? 0);
    }

    public sealed class StatRange
    {
        public int Min, Max;
        internal static StatRange Parse(JsonNode o) => new StatRange { Min = J.Int(o, "min"), Max = J.Int(o, "max") };
    }

    public sealed class BreedingPreview
    {
        public Dictionary<string, StatRange> Stats = new Dictionary<string, StatRange>();
        public bool Nick;
        public int InbreedingCount;
        /// <summary>Style → probability in thousandths of a percent (47.5% = 47500). No floating point.</summary>
        public Dictionary<string, long> StyleMilliPercent = new Dictionary<string, long>();
        public int DistanceMinM, DistanceMaxM;
        public string Surface;
        internal static BreedingPreview Parse(JsonNode o)
        {
            var d = J.Opt(o, "distance");
            return new BreedingPreview
            {
                Stats = J.Map(o, "stats", StatRange.Parse), Nick = J.Bool(o, "nick"), InbreedingCount = J.Int(o, "inbreedingCount"),
                StyleMilliPercent = J.Map(o, "styles", J.Milli), DistanceMinM = J.Int(d, "minM"), DistanceMaxM = J.Int(d, "maxM"), Surface = J.Str(o, "surface"),
            };
        }
    }

    public sealed class BreedResult
    {
        public Horse Foal;
        public bool Nick;
        public int InbreedingCount;
        internal static BreedResult Parse(JsonNode o) => new BreedResult { Foal = Horse.Parse(J.Opt(o, "foal")), Nick = J.Bool(o, "nick"), InbreedingCount = J.Int(o, "inbreedingCount") };
    }

    public sealed class LoginBonusResult
    {
        public int Day;
        public Reward Reward;
        internal static LoginBonusResult Parse(JsonNode o) => new LoginBonusResult { Day = J.Int(o, "day"), Reward = Reward.Parse(J.Opt(o, "reward")) };
    }

    public sealed class Mission
    {
        public string Id, Kind;
        public int Target, Progress;
        public bool Claimed;
        public Reward Reward;
        public bool Claimable => !Claimed && Progress >= Target;
        internal static Mission Parse(JsonNode o) => new Mission
        {
            Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), Target = J.Int(o, "target"), Progress = J.Int(o, "progress"),
            Claimed = J.Bool(o, "claimed"), Reward = Reward.Parse(J.Opt(o, "reward")),
        };
    }

    public sealed class SeasonPassView
    {
        public int Level, Xp;
        public bool Active;
        public long ExpiresAt;
        public int[] ClaimedFree = new int[0], ClaimedPremium = new int[0];
        internal static SeasonPassView Parse(JsonNode o)
        {
            var c = J.Opt(o, "claimed");
            return new SeasonPassView { Level = J.Int(o, "level"), Xp = J.Int(o, "xp"), Active = J.Bool(o, "active"), ExpiresAt = J.Long(o, "expiresAt"), ClaimedFree = J.Ints(c, "free"), ClaimedPremium = J.Ints(c, "premium") };
        }
    }

    /// <summary>Seat in a race: connect to WsPath and send hello with Ticket (see <see cref="RaceSession"/>).</summary>
    public sealed class RaceAssignment
    {
        public string RaceId, Ticket, WsPath;
        public int Slot;
        public long StartAtMs;
        internal static RaceAssignment Parse(JsonNode o) => o == null ? null : new RaceAssignment
        {
            RaceId = J.Str(o, "raceId"), Ticket = J.Str(o, "ticket"), WsPath = J.Str(o, "wsPath"), Slot = J.Int(o, "slot"), StartAtMs = J.Long(o, "startAtMs"),
        };
    }

    public enum MatchState { None, Queued, Matched }

    public sealed class MatchStatus
    {
        public MatchState State;
        /// <summary>Set when <see cref="State"/> is Matched.</summary>
        public RaceAssignment Assignment;
        internal static MatchStatus Parse(JsonNode o)
        {
            string s = J.Str(o, "state");
            var st = s == "matched" ? MatchState.Matched : s == "queued" ? MatchState.Queued : MatchState.None;
            return new MatchStatus { State = st, Assignment = st == MatchState.Matched ? RaceAssignment.Parse(o) : null };
        }
    }

    public sealed class FriendRoom
    {
        public string Passphrase;
        public string[] Members = new string[0];
        internal static FriendRoom Parse(JsonNode o) => new FriendRoom { Passphrase = J.Str(o, "passphrase"), Members = J.Strs(o, "members") };
    }
}
