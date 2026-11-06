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
        /// <summary>Ground preference: "any" | "fast" (firm/fast ground) | "heavy" (soft/sloppy ground). REQ-RACE-035.</summary>
        public string GoingAptitude = "any";
        public int DistMinM, DistMaxM, Awakening;
        public long BornAt;
        public bool Named;
        public Stats Base;
        /// <summary>Look (contracts/assets.md). Use AssetKeys.HorseKeys(Appearance).</summary>
        public Appearance Appearance = new Appearance();
        /// <summary>Set when the sire was another player's stallion (REQ-BREED-014); SireId is then null.</summary>
        public StudSireRef StudSire;
        /// <summary>Trait inherited from a grandparent (隔世遺伝, REQ-BREED-017), or null.</summary>
        public AtavismTrait Atavism;
        /// <summary>固有スキル id (REQ-UXS-050), or null (no skill / older servers). Look it up with <see cref="SkillCatalog.Find"/>.</summary>
        public string SkillId;
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
            GoingAptitude = J.Str(o, "goingAptitude") ?? "any",
            Appearance = Appearance.Parse(J.Opt(o, "appearance")) ?? new Appearance(),
            StudSire = StudSireRef.Parse(J.Opt(o, "studSire")), Atavism = AtavismTrait.Parse(J.Opt(o, "atavism")),
            SkillId = J.Str(o, "skillId"),
        };
    }

    /// <summary>
    /// A unique skill (固有スキル, REQ-UXS-050) from GET /v1/skills. Condition/Effect are generated by the server from the very values
    /// the engine uses; display them verbatim. Skills fire from conditions only (no odds), once per race.
    /// </summary>
    public sealed class SkillInfo
    {
        public string Id, Name, Rarity, Trigger;
        public string[] Styles = new string[0];
        public int Value, SpeedPermille, AccelPermille, DrainSavePermille, RecoverPermille, DurationTicks;
        /// <summary>When it fires, e.g. "最後の直線で前に2頭以内".</summary>
        public string Condition;
        /// <summary>What it does, e.g. "4秒間 目標速度+1.8%".</summary>
        public string Effect;
        /// <summary>What it does in races that cap skills (ranked, tournaments, capped events).</summary>
        public string RankedEffect;
        internal static SkillInfo Parse(JsonNode o) => o == null ? null : new SkillInfo
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Rarity = J.Str(o, "rarity"), Trigger = J.Str(o, "trigger"), Styles = J.Strs(o, "styles"),
            Value = J.Int(o, "value"), SpeedPermille = J.Int(o, "speedPermille"), AccelPermille = J.Int(o, "accelPermille"),
            DrainSavePermille = J.Int(o, "drainSavePermille"), RecoverPermille = J.Int(o, "recoverPermille"), DurationTicks = J.Int(o, "durationTicks"),
            Condition = J.Str(o, "condition"), Effect = J.Str(o, "effect"), RankedEffect = J.Str(o, "rankedEffect") ?? J.Str(o, "effect"),
        };
    }

    /// <summary>GET /v1/skills. Cache per ConfigInfo.Hash like other master data.</summary>
    public sealed class SkillCatalog
    {
        public List<SkillInfo> Skills = new List<SkillInfo>();
        public string Notice;
        public SkillInfo Find(string id)
        {
            if (id == null) return null;
            foreach (var s in Skills) if (s.Id == id) return s;
            return null;
        }
        internal static SkillCatalog Parse(JsonNode o) => new SkillCatalog { Skills = J.List(o, "skills", SkillInfo.Parse), Notice = J.Str(o, "notice") };
    }

    /// <summary>Short skill summary shown with gacha odds rows and breeding previews (display only).</summary>
    public sealed class SkillSummary
    {
        public string Id, Name, Rarity, Condition, Effect;
        internal static SkillSummary Parse(JsonNode o) => o == null ? null : new SkillSummary
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Rarity = J.Str(o, "rarity"), Condition = J.Str(o, "condition"), Effect = J.Str(o, "effect"),
        };
    }

    /// <summary>Foal skill odds in a breeding preview (same function as the real breeding, REQ-UXS-050).</summary>
    public sealed class SkillInheritPreview
    {
        public int NonePermille = 1000;
        public List<SkillInheritCandidate> Candidates = new List<SkillInheritCandidate>();
        internal static SkillInheritPreview Parse(JsonNode o) => o == null ? new SkillInheritPreview() : new SkillInheritPreview
        {
            NonePermille = J.Int(o, "nonePermille", 1000), Candidates = J.List(o, "candidates", SkillInheritCandidate.Parse),
        };
    }

    public sealed class SkillInheritCandidate
    {
        public SkillSummary Skill;
        public int Permille;
        /// <summary>"sire" and/or "dam".</summary>
        public string[] From = new string[0];
        internal static SkillInheritCandidate Parse(JsonNode o) => new SkillInheritCandidate { Skill = SkillSummary.Parse(o), Permille = J.Int(o, "permille"), From = J.Strs(o, "from") };
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
        /// <summary>Template id granted as a horse (event rewards), or null.</summary>
        public string Horse;
        /// <summary>REQ-UXS-013: template id granted as a retired broodmare (beginner login bonus day 2), or null.</summary>
        public string Broodmare;
        /// <summary>REQ-UXS-016: season pass experience (season missions).</summary>
        public int PassXp;
        internal static Reward Parse(JsonNode o) => o == null ? new Reward() : new Reward
        {
            FreeCoins = J.Int(o, "freeCoins"), Items = J.List(o, "items", ItemQty.Parse), Horse = J.Str(o, "horse"), Broodmare = J.Str(o, "broodmare"), PassXp = J.Int(o, "passXp"),
        };
    }

    public sealed class SeasonPassState
    {
        public long ExpiresAt;
        public int Xp;
        public int[] ClaimedFree = new int[0], ClaimedPremium = new int[0];
        public string SeasonId;
        /// <summary>REQ-UXS-019: XP added by a Pass+ purchase this season.</summary>
        public int BoostXp;
        internal static SeasonPassState Parse(JsonNode o)
        {
            var c = J.Opt(o, "claimed");
            return new SeasonPassState { ExpiresAt = J.Long(o, "expiresAt"), Xp = J.Int(o, "xp"), ClaimedFree = J.Ints(c, "free"), ClaimedPremium = J.Ints(c, "premium"), SeasonId = J.Str(o, "seasonId"), BoostXp = J.Int(o, "boostXp") };
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
        /// <summary>REQ-UXS-013: beginner login bonus days claimed (null on states from before the beginner table).</summary>
        public int? LoginBeginnerDay;
        /// <summary>REQ-UXS-002: the first partner horse (null until POST /v1/player/partner).</summary>
        public string PartnerHorseId;
        /// <summary>REQ-UXS-001: terms / privacy consent; show the consent screen while <see cref="ConsentView.Required"/>.</summary>
        public ConsentView Consent;
        /// <summary>REQ-UXS-014: which features the home screen shows (display only; the APIs work anyway).</summary>
        public UnlocksView Unlocks;
        /// <summary>REQ-UXS-032: A/B assignments and the values to use.</summary>
        public ExperimentsView Experiments;
        /// <summary>REQ-UXS-040: account deletion status.</summary>
        public DeletionStatus Deletion;
        public int Rating, RatingDeviation, RankedRaces;
        public string SeasonId, ClassId;
        public int SeasonPoints;
        public string DisplayName, TitleId;
        /// <summary>Your silks (contracts/assets.md §3). Change with ApiClient.SetSilksAsync.</summary>
        public Silks Silks = new Silks();
        /// <summary>Equipped tack and stable decor (REQ-ITEM-006). Change with ApiClient.SetEquipmentAsync.</summary>
        public Equipment Equipment = new Equipment();

        internal static PlayerView Parse(JsonNode o)
        {
            var lb = J.Opt(o, "loginBonus");
            var pr = J.Opt(o, "profile");
            var r = J.Opt(o, "rating");
            var s = J.Opt(o, "season");
            return new PlayerView
            {
                Id = J.Str(o, "id"), Wallet = Wallet.Parse(J.Opt(o, "wallet")),
                Items = J.Map(o, "items", v => v.AsInt()), AwakeningMaterial = J.Int(J.Opt(o, "materials"), "awakening"),
                Pity = J.Map(o, "pity", v => v.AsInt()), Horses = J.List(o, "horses", Horse.Parse),
                AgeRegistered = J.Bool(o, "ageRegistered"), TutorialGachaUsed = J.Bool(J.Opt(o, "flags"), "tutorialGachaUsed"),
                SeasonPass = SeasonPassState.Parse(J.Opt(o, "seasonPass")),
                LoginStreakDay = J.Int(lb, "streakDay"), LoginLastClaimDate = J.Str(lb, "lastClaimDate"), LoginBeginnerDay = J.IntN(lb, "beginnerDay"),
                PartnerHorseId = J.Str(J.Opt(o, "flags"), "partnerHorseId"),
                Consent = ConsentView.Parse(J.Opt(o, "consent")), Unlocks = UnlocksView.Parse(J.Opt(o, "unlocks")),
                Experiments = ExperimentsView.Parse(J.Opt(o, "experiments")), Deletion = DeletionStatus.Parse(J.Opt(o, "deletion")),
                Rating = J.Int(r, "r"), RatingDeviation = J.Int(r, "rd"), RankedRaces = J.Int(r, "rankedRaces"),
                SeasonId = J.Str(s, "id"), ClassId = J.Str(s, "classId"), SeasonPoints = J.Int(s, "points"),
                DisplayName = J.Str(pr, "displayName"), TitleId = J.Str(pr, "titleId"), Silks = Silks.Parse(J.Opt(pr, "silks")) ?? new Silks(),
                Equipment = Equipment.Parse(J.Opt(o, "equipment")),
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

    /// <summary>
    /// A store product. The display fields (REQ-UXS-022, protocol §13.1) are built on the server: show
    /// <see cref="Contents"/> labels, <see cref="FirstPurchaseBonus"/> and the notices as they are, never build bonus wording.
    /// </summary>
    public sealed class Product
    {
        public string Id, Kind;
        public int PriceYen, PaidCoins;
        public bool Once;
        public int? DurationDays;
        public List<ItemQty> Items = new List<ItemQty>();
        /// <summary>Display name, tab ("recommended" | "coins" | "pass") and store type ("consumable" | "non_consumable").</summary>
        public string Name, Tab, StoreType;
        /// <summary>Promotion packs: the class the pack belongs to (B/A/S), else null.</summary>
        public string ClassId;
        public bool AutoRenew;
        public List<ProductContent> Contents = new List<ProductContent>();
        public FirstPurchaseBonus FirstPurchaseBonus;
        public bool OneTime;
        /// <summary>"account" | "class" | null.</summary>
        public string OneTimeScope;
        /// <summary>Period it is sold for: { kind: "season" } or { kind: "days", days }; null for coin packs.</summary>
        public ProductPeriod Period;
        public List<string> NoticeKeys = new List<string>();
        /// <summary>Season pass / Pass+: levels added at purchase (0 for the plain pass).</summary>
        public int PassLevels;
        /// <summary>厩舎手当: days and daily free coins; null for other products.</summary>
        public AllowanceTerms Allowance;
        internal static Product Parse(JsonNode o) => new Product
        {
            Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), PriceYen = J.Int(o, "priceYen"), PaidCoins = J.Int(o, "paidCoins"),
            Once = J.Bool(o, "once"), DurationDays = J.IntN(o, "durationDays"), Items = J.List(o, "items", ItemQty.Parse),
            Name = J.Str(o, "name"), Tab = J.Str(o, "tab"), StoreType = J.Str(o, "storeType"), ClassId = J.Str(o, "classId"), AutoRenew = J.Bool(o, "autoRenew"),
            Contents = J.List(o, "contents", ProductContent.Parse), FirstPurchaseBonus = FirstPurchaseBonus.Parse(J.Opt(o, "firstPurchaseBonus")),
            OneTime = J.Bool(o, "oneTime"), OneTimeScope = J.Str(o, "oneTimeScope"), Period = ProductPeriod.Parse(J.Opt(o, "period")),
            NoticeKeys = J.List(o, "noticeKeys", x => x.AsString()), PassLevels = J.Int(J.Opt(o, "pass"), "levels"),
            Allowance = AllowanceTerms.Parse(J.Opt(o, "allowance")),
        };
    }

    public sealed class ProductList
    {
        public List<Product> Products = new List<Product>();
        /// <summary>Shop notice to display (e.g. 有償コインから先に使われます).</summary>
        public string Notice;
        /// <summary>REQ-UXS-022: notice texts by key (<see cref="Product.NoticeKeys"/>).</summary>
        public Dictionary<string, string> Notices = new Dictionary<string, string>();
        /// <summary>特商法 / 資金決済法 / 有償コインの使用順 links (key + title).</summary>
        public List<LegalLink> LegalLinks = new List<LegalLink>();
        internal static ProductList Parse(JsonNode o) => new ProductList
        {
            Products = J.List(o, "products", Product.Parse), Notice = J.Str(o, "notice"),
            Notices = J.Map(o, "notices", v => v.AsString()), LegalLinks = J.List(o, "legalLinks", LegalLink.Parse),
        };
    }

    public sealed class ConfigInfo
    {
        public string VersionId, Hash, RulesetVersion;
        public long? ActivatedAt;
        /// <summary>Version of GET /v1/visuals; refetch the catalog when it changes.</summary>
        public int VisualsVersion;
        internal static ConfigInfo Parse(JsonNode o) => new ConfigInfo
        {
            VersionId = J.Str(o, "versionId"), Hash = J.Str(o, "hash"), RulesetVersion = J.Str(o, "rulesetVersion"),
            ActivatedAt = J.Opt(o, "activatedAt") is JsonNode n && !n.IsNull ? n.AsLong() : (long?)null,
            VisualsVersion = J.Int(o, "visualsVersion"),
        };
    }

    public sealed class StoreAccount
    {
        public string AppleAppAccountToken, GoogleObfuscatedAccountId;
        internal static StoreAccount Parse(JsonNode o) => new StoreAccount
        {
            AppleAppAccountToken = J.Str(o, "appleAppAccountToken"), GoogleObfuscatedAccountId = J.Str(o, "googleObfuscatedAccountId"),
        };
    }

    public sealed class PurchaseIntent
    {
        public Product Product;
        public int MonthSpentYen;
        public int? MonthlyLimitYen, RemainingYen;
        /// <summary>REQ-UXS-022: only while this coin pack still has its first-purchase bonus for the player.</summary>
        public FirstPurchaseBonus FirstPurchaseBonus;
        /// <summary>REQ-UXS-020: season pass / Pass+ only (show "このパスは◯日で終わります" when LastWeek).</summary>
        public PassPurchaseInfo Pass;
        /// <summary>REQ-UXS-018: 厩舎手当 only.</summary>
        public AllowanceTerms Allowance;
        internal static PurchaseIntent Parse(JsonNode o) => new PurchaseIntent
        {
            Product = Product.Parse(J.Opt(o, "product")), MonthSpentYen = J.Int(o, "monthSpentYen"),
            MonthlyLimitYen = J.IntN(o, "monthlyLimitYen"), RemainingYen = J.IntN(o, "remainingYen"),
            FirstPurchaseBonus = FirstPurchaseBonus.Parse(J.Opt(o, "firstPurchaseBonus")), Pass = PassPurchaseInfo.Parse(J.Opt(o, "pass")),
            Allowance = AllowanceTerms.Parse(J.Opt(o, "allowance")),
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
        /// <summary>Limited-time (季節限定) horse: label and when it leaves the table. Null for permanent horses.</summary>
        public LimitedInfo Limited;
        /// <summary>The horse's unique skill (display only; never part of the odds). Null on older servers.</summary>
        public SkillSummary Skill;
        internal static OddsRow Parse(JsonNode o) => new OddsRow { TemplateId = J.Str(o, "templateId"), Name = J.Str(o, "name"), Rarity = J.Str(o, "rarity"), Ppm = J.Int(o, "ppm"), Rate = J.Str(o, "rate"), Limited = LimitedInfo.Parse(J.Opt(o, "limited")), Skill = SkillSummary.Parse(J.Opt(o, "skill")) };
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
        /// <summary>Ticket item ids that draw on this banner from this very table (REQ-ITEM-001).</summary>
        public List<string> TicketsUsable = new List<string>();
        /// <summary>Banner period (null = permanent).</summary>
        public long? StartAtMs, EndAtMs;
        /// <summary>Notice shown when the table contains limited horses (null otherwise). Display verbatim.</summary>
        public string LimitedNotice;

        internal static OddsDisclosure Parse(JsonNode o)
        {
            var g = J.Opt(o, "guarantee");
            var p = J.Opt(o, "pity");
            var per = J.Opt(o, "period");
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
                TicketsUsable = J.List(o, "tickets", x => J.Str(x, "itemId")),
                StartAtMs = J.LongN(per, "startAtMs"), EndAtMs = J.LongN(per, "endAtMs"), LimitedNotice = J.Str(o, "limitedNotice"),
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
        /// <summary>Look of the pulled horse (the template's look for a duplicate) for the reveal animation.</summary>
        public Appearance Appearance;
        internal static PullResult Parse(JsonNode o) => new PullResult
        {
            TemplateId = J.Str(o, "templateId"), Rarity = J.Str(o, "rarity"), HorseId = J.Str(o, "horseId"),
            Duplicate = J.Bool(o, "duplicate"), Guaranteed = J.Bool(o, "guaranteed"), Material = J.Int(o, "material"),
            Appearance = Appearance.Parse(J.Opt(o, "appearance")),
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
        /// <summary>Foal ground preference odds in permille ("any" / "fast" / "heavy"), same function as the real breeding.</summary>
        public Dictionary<string, int> GoingAptitudePermille = new Dictionary<string, int>();
        /// <summary>Today's breeding allowance incl. extra breedings with breeding material (REQ-ITEM-003). Null on older servers.</summary>
        public BreedingAllowance Today;
        /// <summary>隔世遺伝 odds (REQ-BREED-018); empty on older servers.</summary>
        public AtavismOdds Atavism = new AtavismOdds();
        /// <summary>Foal skill odds (REQ-UXS-050); "no skill" 1000‰ on older servers.</summary>
        public SkillInheritPreview Skill = new SkillInheritPreview();
        internal static BreedingPreview Parse(JsonNode o)
        {
            var d = J.Opt(o, "distance");
            return new BreedingPreview
            {
                Stats = J.Map(o, "stats", StatRange.Parse), Nick = J.Bool(o, "nick"), InbreedingCount = J.Int(o, "inbreedingCount"),
                StyleMilliPercent = J.Map(o, "styles", J.Milli), DistanceMinM = J.Int(d, "minM"), DistanceMaxM = J.Int(d, "maxM"), Surface = J.Str(o, "surface"),
                GoingAptitudePermille = J.Opt(o, "goingAptitude") == null ? new Dictionary<string, int>() : J.Map(o, "goingAptitude", n => n.AsInt()),
                Today = BreedingAllowance.Parse(J.Opt(o, "today")),
                Atavism = AtavismOdds.Parse(J.Opt(o, "atavism")),
                Skill = SkillInheritPreview.Parse(J.Opt(o, "skill")),
            };
        }
    }

    public sealed class BreedResult
    {
        public Horse Foal;
        public bool Nick;
        public int InbreedingCount;
        /// <summary>True when this was an extra breeding paid with breeding material (REQ-ITEM-003).</summary>
        public bool UsedMaterial;
        public AtavismTrait Atavism;
        /// <summary>Skill the foal inherited (REQ-UXS-050), or null.</summary>
        public string SkillId;
        internal static BreedResult Parse(JsonNode o) => new BreedResult { Foal = Horse.Parse(J.Opt(o, "foal")), Nick = J.Bool(o, "nick"), InbreedingCount = J.Int(o, "inbreedingCount"), UsedMaterial = J.Bool(o, "usedMaterial"), Atavism = AtavismTrait.Parse(J.Opt(o, "atavism")), SkillId = J.Str(o, "skillId") };
    }

    public sealed class LoginBonusResult
    {
        public int Day;
        public Reward Reward;
        /// <summary>REQ-UXS-013: "beginner" (the first-week table, once) or "normal" (the 7-day cycle).</summary>
        public string Track = "normal";
        /// <summary>Beginner days still to come (0 on the normal track).</summary>
        public int BeginnerDaysLeft;
        public bool IsBeginner => Track == "beginner";
        internal static LoginBonusResult Parse(JsonNode o) => new LoginBonusResult
        {
            Day = J.Int(o, "day"), Reward = Reward.Parse(J.Opt(o, "reward")), Track = J.Str(o, "track") ?? "normal", BeginnerDaysLeft = J.Int(o, "beginnerDaysLeft"),
        };
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

    /// <summary>GET /v1/season-pass (REQ-UXS-020/021, protocol §13.6): everything the pass screen needs, from the server.</summary>
    public sealed class SeasonPassView
    {
        public int Level, Xp;
        /// <summary>True while this season's pass is owned (the premium line can be claimed).</summary>
        public bool Active;
        public long ExpiresAt;
        public int[] ClaimedFree = new int[0], ClaimedPremium = new int[0];
        public string SeasonId;
        public int XpPerLevel, MaxLevel, XpToNextLevel, RacesToNextLevel;
        public long SeasonEndsAt;
        public int RemainingDays;
        public bool LastWeek, AutoRenew, AutoGrantAtSeasonEnd;
        /// <summary>Levels added by a Pass+ purchase this season.</summary>
        public int BoostLevels;
        /// <summary>Product ids owned for this season / still purchasable (empty once one is owned).</summary>
        public List<string> Owned = new List<string>(), Purchasable = new List<string>();
        public PassLine FreeLine, PremiumLine;
        /// <summary>The previous season's close (auto-granted levels), or null.</summary>
        public PassSeasonRecord LastSeason;
        internal static SeasonPassView Parse(JsonNode o)
        {
            var c = J.Opt(o, "claimed");
            var rw = J.Opt(o, "rewards");
            return new SeasonPassView
            {
                Level = J.Int(o, "level"), Xp = J.Int(o, "xp"), Active = J.Bool(o, "active"), ExpiresAt = J.Long(o, "expiresAt"), ClaimedFree = J.Ints(c, "free"), ClaimedPremium = J.Ints(c, "premium"),
                SeasonId = J.Str(o, "seasonId"), XpPerLevel = J.Int(o, "xpPerLevel"), MaxLevel = J.Int(o, "maxLevel"), XpToNextLevel = J.Int(o, "xpToNextLevel"), RacesToNextLevel = J.Int(o, "racesToNextLevel"),
                SeasonEndsAt = J.Long(o, "seasonEndsAt"), RemainingDays = J.Int(o, "remainingDays"), LastWeek = J.Bool(o, "lastWeek"), AutoRenew = J.Bool(o, "autoRenew"),
                AutoGrantAtSeasonEnd = J.Bool(o, "autoGrantAtSeasonEnd"), BoostLevels = J.Int(o, "boostLevels"),
                Owned = J.List(o, "owned", x => x.AsString()), Purchasable = J.List(o, "purchasable", x => x.AsString()),
                FreeLine = PassLine.Parse(J.Opt(rw, "free")), PremiumLine = PassLine.Parse(J.Opt(rw, "premium")),
                LastSeason = PassSeasonRecord.Parse(J.Opt(o, "lastSeason")),
            };
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

    public sealed class TitleInfo
    {
        public string Id, Name;
        /// <summary>Asset key of the title icon (title/&lt;id&gt;).</summary>
        public string Icon;
        public bool Unlocked;
        internal static TitleInfo Parse(JsonNode o) => new TitleInfo { Id = J.Str(o, "id"), Name = J.Str(o, "name"), Icon = J.Str(o, "icon") ?? AssetKeys.Title(J.Str(o, "id") ?? "default"), Unlocked = J.Bool(o, "unlocked") };
    }

    public sealed class TitleList
    {
        public string Equipped;
        public List<TitleInfo> Titles = new List<TitleInfo>();
        internal static TitleList Parse(JsonNode o) => new TitleList { Equipped = J.Str(o, "equipped"), Titles = J.List(o, "titles", TitleInfo.Parse) };
    }

    public sealed class WinCount
    {
        public int Races, Wins;
        public int? BestFinishTick;
        internal static WinCount Parse(JsonNode o) => new WinCount { Races = J.Int(o, "races"), Wins = J.Int(o, "wins"), BestFinishTick = J.IntN(o, "bestFinishTick") };
    }

    public sealed class PlayerStats
    {
        public int Races, Wins, Top3, WhipPerfectWins, PerfectStarts;
        /// <summary>Ticks between the gate opening and the player's START (0 = perfect); null until recorded.</summary>
        public int? BestStartReactionTicks;
        public Dictionary<string, WinCount> ByStyle = new Dictionary<string, WinCount>();
        /// <summary>Per track id; BestFinishTick × 50 ms = best time.</summary>
        public Dictionary<string, WinCount> ByTrack = new Dictionary<string, WinCount>();
        internal static PlayerStats Parse(JsonNode o) => new PlayerStats
        {
            Races = J.Int(o, "races"), Wins = J.Int(o, "wins"), Top3 = J.Int(o, "top3"), WhipPerfectWins = J.Int(o, "whipPerfectWins"),
            PerfectStarts = J.Int(o, "perfectStarts"), BestStartReactionTicks = J.IntN(o, "bestStartReactionTicks"),
            ByStyle = J.Map(o, "byStyle", WinCount.Parse), ByTrack = J.Map(o, "byTrack", WinCount.Parse),
        };
    }

    public sealed class RankInfo
    {
        public string ClassId;
        public int ClassRank, ClassTotal, RatingRank, RatingTotal;
        internal static RankInfo Parse(JsonNode o) => o == null ? null : new RankInfo
        {
            ClassId = J.Str(o, "classId"), ClassRank = J.Int(o, "classRank"), ClassTotal = J.Int(o, "classTotal"),
            RatingRank = J.Int(o, "ratingRank"), RatingTotal = J.Int(o, "ratingTotal"),
        };
    }

    public sealed class Standing
    {
        public string ClassId;
        public int Points, Rating, Races;
        internal static Standing Parse(JsonNode o) => o == null ? null : new Standing { ClassId = J.Str(o, "classId"), Points = J.Int(o, "points"), Rating = J.Int(o, "rating"), Races = J.Int(o, "races") };
    }

    public sealed class MyRank
    {
        /// <summary>Null until the player appears in a published snapshot.</summary>
        public RankInfo Rank;
        public Standing Standing;
        public long? GeneratedAt;
        internal static MyRank Parse(JsonNode o) => new MyRank { Rank = RankInfo.Parse(J.Opt(o, "rank")), Standing = Standing.Parse(J.Opt(o, "standing")), GeneratedAt = J.LongN(o, "generatedAt") };
    }

    public sealed class BoardRow
    {
        public int Rank, Points, Rating, Races;
        public string PlayerId, DisplayName, TitleId, ClassId;
        internal static BoardRow Parse(JsonNode o) => new BoardRow
        {
            Rank = J.Int(o, "rank"), PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), TitleId = J.Str(o, "titleId"),
            ClassId = J.Str(o, "classId"), Points = J.Int(o, "points"), Rating = J.Int(o, "rating"), Races = J.Int(o, "races"),
        };
    }

    public sealed class BoardIndexEntry
    {
        public string Board, Key;
        public int Total;
        internal static BoardIndexEntry Parse(JsonNode o) => new BoardIndexEntry { Board = J.Str(o, "board"), Key = J.Str(o, "key"), Total = J.Int(o, "total") };
    }

    /// <summary>A leaderboard snapshot (or, for board "index", the list of boards in <see cref="Boards"/>).</summary>
    public sealed class LeaderboardFile
    {
        public string SeasonId, Board;
        public long? GeneratedAt;
        public int Total;
        public List<BoardRow> Entries = new List<BoardRow>();
        public List<BoardIndexEntry> Boards = new List<BoardIndexEntry>();
        internal static LeaderboardFile Parse(JsonNode o) => new LeaderboardFile
        {
            SeasonId = J.Str(o, "seasonId"), Board = J.Str(o, "board"), GeneratedAt = J.LongN(o, "generatedAt"), Total = J.Int(o, "total"),
            Entries = J.List(o, "entries", BoardRow.Parse), Boards = J.List(o, "boards", BoardIndexEntry.Parse),
        };
    }

    public sealed class PublicProfile
    {
        public string PlayerId, DisplayName, TitleId, ClassId;
        public int Rating, Races, Wins, Top3;
        public long LastSeenAt;
        public Silks Silks;
        /// <summary>Only on incoming/outgoing requests.</summary>
        public long? RequestedAt;
        internal static PublicProfile Parse(JsonNode o)
        {
            var st = J.Opt(o, "stats");
            return new PublicProfile
            {
                PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), TitleId = J.Str(o, "titleId"), ClassId = J.Str(o, "classId"),
                Rating = J.Int(o, "rating"), Races = J.Int(st, "races"), Wins = J.Int(st, "wins"), Top3 = J.Int(st, "top3"),
                LastSeenAt = J.Long(o, "lastSeenAt"), RequestedAt = J.LongN(o, "requestedAt"), Silks = Silks.Parse(J.Opt(o, "silks")),
            };
        }
    }

    public sealed class FriendInvite
    {
        public PublicProfile From;
        public string Passphrase;
        public long At;
        internal static FriendInvite Parse(JsonNode o) => new FriendInvite { From = PublicProfile.Parse(J.Opt(o, "from")), Passphrase = J.Str(o, "passphrase"), At = J.Long(o, "at") };
    }

    public sealed class FriendList
    {
        public List<PublicProfile> Friends = new List<PublicProfile>(), Incoming = new List<PublicProfile>(), Outgoing = new List<PublicProfile>();
        public List<FriendInvite> Invites = new List<FriendInvite>();
        internal static FriendList Parse(JsonNode o) => new FriendList
        {
            Friends = J.List(o, "friends", PublicProfile.Parse), Incoming = J.List(o, "incoming", PublicProfile.Parse),
            Outgoing = J.List(o, "outgoing", PublicProfile.Parse), Invites = J.List(o, "invites", FriendInvite.Parse),
        };
    }

    // ------------------------------------------------------------------ push (REQ-PUSH)

    public sealed class PushPreferences
    {
        public bool Season, Friends, Invites, Events;
        /// <summary>Quiet hours in JST (0-23); null = none. Urgent pushes (room invites) are not sent then; others are delayed.</summary>
        public int? QuietStartHour, QuietEndHour;
        public int DailyCap, Devices;
        /// <summary>FCM topics the app must subscribe to / unsubscribe from (broadcasts such as season reminders).</summary>
        public List<string> SubscribeTopics = new List<string>(), UnsubscribeTopics = new List<string>();

        internal static PushPreferences Parse(JsonNode o)
        {
            var c = J.Opt(o, "categories");
            var q = J.Opt(o, "quietHours");
            var t = J.Opt(o, "topics");
            return new PushPreferences
            {
                Season = J.Bool(c, "season"), Friends = J.Bool(c, "friends"), Invites = J.Bool(c, "invites"), Events = J.Bool(c, "events"),
                QuietStartHour = q == null ? (int?)null : J.Int(q, "startHour"), QuietEndHour = q == null ? (int?)null : J.Int(q, "endHour"),
                DailyCap = J.Int(o, "dailyCap"), Devices = J.Int(o, "devices"),
                SubscribeTopics = J.List(t, "subscribe", x => x.AsString()), UnsubscribeTopics = J.List(t, "unsubscribe", x => x.AsString()),
            };
        }
    }

    /// <summary>Only the fields you set are sent. Set <see cref="ClearQuietHours"/> to turn quiet hours off.</summary>
    public sealed class PushPreferencesPatch
    {
        public bool? Season, Friends, Invites, Events;
        public int? QuietStartHour, QuietEndHour;
        public bool ClearQuietHours;

        internal JsonNode ToJson()
        {
            var b = JsonNode.Obj();
            if (Season.HasValue || Friends.HasValue || Invites.HasValue || Events.HasValue)
            {
                var c = JsonNode.Obj();
                if (Season.HasValue) c.Set("season", Season.Value);
                if (Friends.HasValue) c.Set("friends", Friends.Value);
                if (Invites.HasValue) c.Set("invites", Invites.Value);
                if (Events.HasValue) c.Set("events", Events.Value);
                b.Set("categories", c);
            }
            if (ClearQuietHours) b.Set("quietHours", JsonNode.Null());
            else if (QuietStartHour.HasValue || QuietEndHour.HasValue)
            {
                if (!QuietStartHour.HasValue || !QuietEndHour.HasValue) throw new ArgumentException("set both QuietStartHour and QuietEndHour");
                if (QuietStartHour < 0 || QuietStartHour > 23 || QuietEndHour < 0 || QuietEndHour > 23) throw new ArgumentOutOfRangeException(nameof(QuietStartHour), "hours are 0-23 (JST)");
                var q = JsonNode.Obj();
                q.Set("startHour", QuietStartHour.Value);
                q.Set("endHour", QuietEndHour.Value);
                b.Set("quietHours", q);
            }
            return b;
        }
    }

    // ------------------------------------------------------------------ analytics (REQ-KPI)

    public sealed class AnalyticsIngestResult
    {
        public int Accepted, Dropped;
        internal static AnalyticsIngestResult Parse(JsonNode o) => new AnalyticsIngestResult { Accepted = J.Int(o, "accepted"), Dropped = J.Int(o, "dropped") };
    }

    public sealed class FriendOpResult
    {
        /// <summary>"requested" or "friends".</summary>
        public string Status, PlayerId;
        internal static FriendOpResult Parse(JsonNode o) => new FriendOpResult { Status = J.Str(o, "status"), PlayerId = J.Str(o, "playerId") };
    }

    // ------------------------------------------------------------------ teams / 支部 (REQ-TEAM)

    public enum TeamJoinPolicy { Open, Approval }
    public enum TeamRole { Member, Officer, Leader }

    /// <summary>Rank as of the last snapshot (team ranking, event ranking).</summary>
    public sealed class PlaceInfo
    {
        public int Rank, Total;
        public long? GeneratedAt;
        internal static PlaceInfo Parse(JsonNode o) => o == null ? null : new PlaceInfo { Rank = J.Int(o, "rank"), Total = J.Int(o, "total"), GeneratedAt = J.LongN(o, "generatedAt") };
    }

    internal static class TeamWire
    {
        public static TeamJoinPolicy Policy(string s) => s == "approval" ? TeamJoinPolicy.Approval : TeamJoinPolicy.Open;
        public static TeamRole Role(string s) => s == "leader" ? TeamRole.Leader : s == "officer" ? TeamRole.Officer : TeamRole.Member;
        public static List<T> Array<T>(JsonNode o, Func<JsonNode, T> f)
        {
            var list = new List<T>();
            if (o != null && o.Kind == JsonKind.Array) foreach (var it in o.Items) list.Add(f(it));
            return list;
        }
    }

    public sealed class TeamMemberInfo
    {
        public string PlayerId, DisplayName;
        public TeamRole Role;
        public long JoinedAt;
        /// <summary>Season points this member adds to the team (earned since joining, capped per member).</summary>
        public int Contribution;
        internal static TeamMemberInfo Parse(JsonNode o) => new TeamMemberInfo
        {
            PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), Role = TeamWire.Role(J.Str(o, "role")),
            JoinedAt = J.Long(o, "joinedAt"), Contribution = J.Int(o, "contribution"),
        };
    }

    public sealed class TeamRequestInfo
    {
        public string PlayerId, DisplayName;
        public long At;
        internal static TeamRequestInfo Parse(JsonNode o) => new TeamRequestInfo { PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), At = J.Long(o, "at") };
    }

    public sealed class TeamInfo
    {
        public string TeamId, Name, Announcement, Season;
        public TeamJoinPolicy JoinPolicy;
        public long CreatedAt;
        public bool Disbanded;
        public int Points, MaxMembers;
        public List<TeamMemberInfo> Members = new List<TeamMemberInfo>();
        /// <summary>Your role when you are a member, else null.</summary>
        public TeamRole? MyRole;
        /// <summary>Pending join requests (only shown to the leader and officers).</summary>
        public List<TeamRequestInfo> Requests = new List<TeamRequestInfo>();
        public Emblem Emblem;
        internal static TeamInfo Parse(JsonNode o)
        {
            if (o == null) return null;
            var role = J.Str(o, "myRole");
            return new TeamInfo
            {
                TeamId = J.Str(o, "teamId"), Name = J.Str(o, "name"), Announcement = J.Str(o, "announcement"), Season = J.Str(o, "season"),
                JoinPolicy = TeamWire.Policy(J.Str(o, "joinPolicy")), CreatedAt = J.Long(o, "createdAt"), Disbanded = J.Bool(o, "disbanded"),
                Points = J.Int(o, "points"), MaxMembers = J.Int(o, "maxMembers"), Members = J.List(o, "members", TeamMemberInfo.Parse),
                MyRole = role == null ? (TeamRole?)null : TeamWire.Role(role), Requests = J.List(o, "requests", TeamRequestInfo.Parse),
                Emblem = Emblem.Parse(J.Opt(o, "emblem")),
            };
        }
    }

    public sealed class MyTeam
    {
        /// <summary>Null when you are not in a team.</summary>
        public TeamInfo Team;
        /// <summary>Epoch ms; joining another team is refused before this (after leaving by choice).</summary>
        public long CooldownUntil;
        /// <summary>Teams you have pending join requests with.</summary>
        public List<string> Outgoing = new List<string>();
        public PlaceInfo Rank;
        internal static MyTeam Parse(JsonNode o) => new MyTeam
        {
            Team = TeamInfo.Parse(J.Opt(o, "team")), CooldownUntil = J.Long(o, "cooldownUntil"),
            Outgoing = J.List(o, "outgoing", x => x.AsString()), Rank = PlaceInfo.Parse(J.Opt(o, "rank")),
        };
    }

    public sealed class TeamSummary
    {
        public string TeamId, Name, Season;
        public TeamJoinPolicy JoinPolicy;
        public int Members, Points;
        public long UpdatedAt;
        public Emblem Emblem;
        internal static TeamSummary Parse(JsonNode o) => new TeamSummary
        {
            TeamId = J.Str(o, "teamId"), Name = J.Str(o, "name"), Season = J.Str(o, "season"), JoinPolicy = TeamWire.Policy(J.Str(o, "joinPolicy")),
            Members = J.Int(o, "members"), Points = J.Int(o, "points"), UpdatedAt = J.Long(o, "updatedAt"), Emblem = Emblem.Parse(J.Opt(o, "emblem")),
        };
        internal static List<TeamSummary> ParseList(JsonNode o) => TeamWire.Array(o, Parse);
    }

    public sealed class TeamBoardRow
    {
        public int Rank, Points, Members;
        public string TeamId, Name;
        internal static TeamBoardRow Parse(JsonNode o) => new TeamBoardRow { Rank = J.Int(o, "rank"), Points = J.Int(o, "points"), Members = J.Int(o, "members"), TeamId = J.Str(o, "teamId"), Name = J.Str(o, "name") };
    }

    public sealed class TeamBoard
    {
        public string SeasonId;
        public long? GeneratedAt;
        public int Total;
        public List<TeamBoardRow> Entries = new List<TeamBoardRow>();
        internal static TeamBoard Parse(JsonNode o) => new TeamBoard
        {
            SeasonId = J.Str(o, "seasonId"), GeneratedAt = J.LongN(o, "generatedAt"), Total = J.Int(o, "total"), Entries = J.List(o, "entries", TeamBoardRow.Parse),
        };
    }

    // ------------------------------------------------------------------ 支部対抗シーズン (REQ-LEAGUE)

    /// <summary>One team's line in a division table.</summary>
    public sealed class LeagueRow
    {
        public string TeamId, Name, DivisionId;
        public int Place, Played, Won, Drawn, Lost, Byes, LeaguePoints, ScoreFor, ScoreAgainst;
        public int ScoreDiff => ScoreFor - ScoreAgainst;
        internal static LeagueRow Parse(JsonNode o) => o == null ? null : new LeagueRow
        {
            TeamId = J.Str(o, "teamId"), Name = J.Str(o, "name"), DivisionId = J.Str(o, "divisionId"), Place = J.Int(o, "place"),
            Played = J.Int(o, "played"), Won = J.Int(o, "won"), Drawn = J.Int(o, "drawn"), Lost = J.Int(o, "lost"), Byes = J.Int(o, "byes"),
            LeaguePoints = J.Int(o, "leaguePoints"), ScoreFor = J.Int(o, "scoreFor"), ScoreAgainst = J.Int(o, "scoreAgainst"),
        };
    }

    /// <summary>
    /// My team's matchup in one week. Status: "pending" (not started), "open" (this week), "scored", "skipped" (the week was
    /// missed). Scores are season-point growth inside the week (null until scored).
    /// </summary>
    public sealed class LeagueMatchup
    {
        public int Index;
        public long StartMs, EndMs;
        public string Status, Opponent, OpponentName;
        public int? MyScore, OpponentScore;
        public bool Bye;
        /// <summary>"win", "draw", "loss", "bye" once scored, else null.</summary>
        public string Outcome => Status != "scored" ? null : Bye ? "bye" : MyScore > OpponentScore ? "win" : MyScore < OpponentScore ? "loss" : "draw";
        internal static LeagueMatchup Parse(JsonNode o) => new LeagueMatchup
        {
            Index = J.Int(o, "index"), StartMs = J.Long(o, "startMs"), EndMs = J.Long(o, "endMs"), Status = J.Str(o, "status"),
            Opponent = J.Str(o, "opponent"), OpponentName = J.Str(o, "opponentName"), MyScore = J.IntN(o, "myScore"), OpponentScore = J.IntN(o, "opponentScore"), Bye = J.Bool(o, "bye"),
        };
    }

    /// <summary>Final place after the season, its reward (paid with the team season reward) and next season's division.</summary>
    public sealed class LeagueFinalPlace
    {
        public string DivisionId, NextDivisionId;
        public int Place, Size;
        public Reward Reward;
        /// <summary>Up / down / same division next season.</summary>
        public int Movement(IList<LeagueDivisionInfo> divisions)
        {
            int Idx(string id) { for (int i = 0; i < divisions.Count; i++) if (divisions[i].Id == id) return i; return -1; }
            int a = Idx(DivisionId), b = Idx(NextDivisionId);
            return a < 0 || b < 0 ? 0 : a - b; // divisions are listed top first: +1 = promoted
        }
        internal static LeagueFinalPlace Parse(JsonNode o) => o == null ? null : new LeagueFinalPlace
        {
            DivisionId = J.Str(o, "divisionId"), NextDivisionId = J.Str(o, "nextDivisionId"), Place = J.Int(o, "place"), Size = J.Int(o, "size"),
            Reward = J.Opt(o, "reward") == null ? null : Reward.Parse(J.Opt(o, "reward")),
        };
    }

    public sealed class LeagueDivisionInfo
    {
        public string Id, Name;
        internal static LeagueDivisionInfo Parse(JsonNode o) => new LeagueDivisionInfo { Id = J.Str(o, "id"), Name = J.Str(o, "name") };
    }

    /// <summary>GET /v1/league/me: my team's league this season. TeamId null = not in a team; DivisionId null = not in the league yet.</summary>
    public sealed class MyLeague
    {
        public string TeamId, Season, DivisionId, DivisionName;
        public List<LeagueDivisionInfo> Divisions = new List<LeagueDivisionInfo>();
        public LeagueRow Row;
        public int? Place, CurrentWeek;
        public List<LeagueRow> Table = new List<LeagueRow>();
        public List<LeagueMatchup> Matches = new List<LeagueMatchup>();
        public LeagueFinalPlace Final;
        public LeagueMatchup ThisWeek => CurrentWeek is int w && w >= 0 && w < Matches.Count ? Matches[w] : null;
        internal static MyLeague Parse(JsonNode o) => new MyLeague
        {
            TeamId = J.Str(o, "teamId"), Season = J.Str(o, "season"), DivisionId = J.Str(o, "divisionId"), DivisionName = J.Str(o, "divisionName"),
            Divisions = J.List(o, "divisions", LeagueDivisionInfo.Parse), Row = LeagueRow.Parse(J.Opt(o, "row")), Place = J.IntN(o, "place"),
            CurrentWeek = J.IntN(o, "currentWeek"), Table = J.List(o, "table", LeagueRow.Parse), Matches = J.List(o, "matches", LeagueMatchup.Parse),
            Final = LeagueFinalPlace.Parse(J.Opt(o, "final")),
        };
    }

    public sealed class LeagueBoardMatch
    {
        public string A, B;
        public int AStart, BStart;
        public int? AScore, BScore;
        internal static LeagueBoardMatch Parse(JsonNode o) => new LeagueBoardMatch
        {
            A = J.Str(o, "a"), B = J.Str(o, "b"), AStart = J.Int(o, "aStart"), BStart = J.Int(o, "bStart"), AScore = J.IntN(o, "aScore"), BScore = J.IntN(o, "bScore"),
        };
    }

    public sealed class LeagueBoardWeek
    {
        public int Index;
        public long StartMs, EndMs;
        public string Status;
        public List<LeagueBoardMatch> Matches = new List<LeagueBoardMatch>();
        internal static LeagueBoardWeek Parse(JsonNode o) => new LeagueBoardWeek
        {
            Index = J.Int(o, "index"), StartMs = J.Long(o, "startMs"), EndMs = J.Long(o, "endMs"), Status = J.Str(o, "status"), Matches = J.List(o, "matches", LeagueBoardMatch.Parse),
        };
    }

    /// <summary>A division's published table and weekly matchups (leaderboard board "league-&lt;divisionId&gt;").</summary>
    public sealed class LeagueBoard
    {
        public string SeasonId, Board, DivisionId, DivisionName;
        public long? GeneratedAt;
        public int Total;
        public int? CurrentWeek;
        public bool Final;
        public List<LeagueRow> Entries = new List<LeagueRow>();
        public List<LeagueBoardWeek> Weeks = new List<LeagueBoardWeek>();
        internal static LeagueBoard Parse(JsonNode o) => new LeagueBoard
        {
            SeasonId = J.Str(o, "seasonId"), Board = J.Str(o, "board"), DivisionId = J.Str(o, "divisionId"), DivisionName = J.Str(o, "divisionName"),
            GeneratedAt = J.LongN(o, "generatedAt"), Total = J.Int(o, "total"), CurrentWeek = J.IntN(o, "currentWeek"), Final = J.Bool(o, "final"),
            Entries = J.List(o, "entries", LeagueRow.Parse), Weeks = J.List(o, "weeks", LeagueBoardWeek.Parse),
        };
    }

    // ------------------------------------------------------------------ event races (REQ-EVENT)

    public sealed class EventFee
    {
        /// <summary>"none", "free" (free coins only) or "item" (a ticket).</summary>
        public string Kind, ItemId;
        public int FreeCoins, Qty;
        internal static EventFee Parse(JsonNode o) => o == null ? new EventFee { Kind = "none" } : new EventFee
        {
            Kind = J.Str(o, "kind"), ItemId = J.Str(o, "itemId"), FreeCoins = J.Int(o, "freeCoins"), Qty = J.Int(o, "qty"),
        };
    }

    public sealed class EventProgress
    {
        public int Points, Races, Wins;
        /// <summary>An entry fee is held for a queued race.</summary>
        public bool Pending, Closed;
        public int? Rank;
        public int[] Milestones = new int[0];
        internal static EventProgress Parse(JsonNode o) => o == null ? null : new EventProgress
        {
            Points = J.Int(o, "points"), Races = J.Int(o, "races"), Wins = J.Int(o, "wins"), Pending = J.Bool(o, "pending"),
            Closed = J.Bool(o, "closed"), Rank = J.IntN(o, "rank"), Milestones = J.Ints(o, "milestones"),
        };
    }

    public sealed class EventInfo
    {
        public string Id, Name;
        /// <summary>Asset key of the event banner (banner/event/&lt;id&gt;).</summary>
        public string Banner;
        /// <summary>"upcoming", "open" or "closed".</summary>
        public string Status;
        public long StartAtMs, EndAtMs;
        public List<string> TrackIds = new List<string>();
        public EventFee Fee;
        public bool Eligible;
        /// <summary>e.g. "class", "ranked_races", "style".</summary>
        public List<string> NotEligibleReasons = new List<string>();
        public EventProgress Me;
        internal static EventInfo Parse(JsonNode o) => o == null ? null : new EventInfo
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Banner = J.Str(o, "banner") ?? AssetKeys.EventBanner(J.Str(o, "id") ?? "default"), Status = J.Str(o, "status"), StartAtMs = J.Long(o, "startAtMs"), EndAtMs = J.Long(o, "endAtMs"),
            TrackIds = J.List(o, "trackIds", x => x.AsString()), Fee = EventFee.Parse(J.Opt(o, "fee")), Eligible = J.Bool(o, "eligible"),
            NotEligibleReasons = J.List(o, "notEligibleReasons", x => x.AsString()), Me = EventProgress.Parse(J.Opt(o, "me")),
        };
        internal static List<EventInfo> ParseList(JsonNode o) => TeamWire.Array(o, Parse);
    }

    public sealed class EventBoardRow
    {
        public int Rank, Points, Races, Wins;
        public string PlayerId, DisplayName;
        internal static EventBoardRow Parse(JsonNode o) => new EventBoardRow
        {
            Rank = J.Int(o, "rank"), Points = J.Int(o, "points"), Races = J.Int(o, "races"), Wins = J.Int(o, "wins"),
            PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"),
        };
    }

    public sealed class EventBoard
    {
        public string EventId;
        public long? GeneratedAt;
        public int Total;
        public List<EventBoardRow> Entries = new List<EventBoardRow>();
        internal static EventBoard Parse(JsonNode o) => new EventBoard
        {
            EventId = J.Str(o, "eventId"), GeneratedAt = J.LongN(o, "generatedAt"), Total = J.Int(o, "total"), Entries = J.List(o, "entries", EventBoardRow.Parse),
        };
    }

    public sealed class MyEvent
    {
        public EventInfo Event;
        public PlaceInfo Rank;
        internal static MyEvent Parse(JsonNode o) => new MyEvent { Event = EventInfo.Parse(J.Opt(o, "event")), Rank = PlaceInfo.Parse(J.Opt(o, "rank")) };
    }
}
