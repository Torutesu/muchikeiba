using System.Collections.Generic;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-BREED-010..019: stud lending (種牡馬の貸し借り) and atavism (隔世遺伝). server/src/domain/stud.ts, horses.ts.

    /// <summary>A grandparent trait that can skip a generation: "style" or "goingAptitude", with its value and the horse it comes from.</summary>
    public sealed class AtavismTrait
    {
        public string Trait, Value, From;
        internal static AtavismTrait Parse(JsonNode o) => o == null ? null : new AtavismTrait { Trait = J.Str(o, "trait"), Value = J.Str(o, "value"), From = J.Str(o, "from") };
    }

    public sealed class AtavismCandidate
    {
        public AtavismTrait Trait;
        /// <summary>Chance of this candidate in millionths (permille × 1000; 13.333‰ = 13333). No floating point.</summary>
        public long PerMillion;
        internal static AtavismCandidate Parse(JsonNode o) => new AtavismCandidate { Trait = AtavismTrait.Parse(o), PerMillion = J.Opt(o, "permille") == null ? 0 : J.Milli(J.Opt(o, "permille")) };
    }

    /// <summary>Atavism odds in a breeding preview, from the same function as the real breeding. Empty when no grandparent has anything to pass on.</summary>
    public sealed class AtavismOdds
    {
        public int ChancePermille;
        public List<AtavismCandidate> Candidates = new List<AtavismCandidate>();
        internal static AtavismOdds Parse(JsonNode o) => o == null ? new AtavismOdds() : new AtavismOdds { ChancePermille = J.Int(o, "chancePermille"), Candidates = J.List(o, "candidates", AtavismCandidate.Parse) };
    }

    /// <summary>The foal's sire was another player's stallion (lineage on both sides).</summary>
    public sealed class StudSireRef
    {
        public string OwnerId, HorseId, SireName, DamName;
        internal static StudSireRef Parse(JsonNode o) => o == null ? null : new StudSireRef { OwnerId = J.Str(o, "ownerId"), HorseId = J.Str(o, "horseId"), SireName = J.Str(o, "sireName"), DamName = J.Str(o, "damName") };
    }

    /// <summary>A listed stallion as shown when browsing (the owner's data stays authoritative).</summary>
    public sealed class StudListing
    {
        public string OwnerId, OwnerName, HorseId, Name, Rarity, Line, Style, Surface, GoingAptitude, Visibility;
        public int DistMinM, DistMaxM, StatTotal, Awakening, Fee, DailyLimit;
        /// <summary>Lends today (reserved or paid); only in my own listings.</summary>
        public int? LentToday;
        public long ListedAt;
        public Appearance Appearance = new Appearance();
        public bool IsPublic => Visibility == "public";

        internal static StudListing Parse(JsonNode o) => new StudListing
        {
            OwnerId = J.Str(o, "ownerId"), OwnerName = J.Str(o, "ownerName"), HorseId = J.Str(o, "horseId"), Name = J.Str(o, "name"),
            Rarity = J.Str(o, "rarity"), Line = J.Str(o, "line"), Style = J.Str(o, "style"), Surface = J.Str(o, "surface"),
            GoingAptitude = J.Str(o, "goingAptitude") ?? "any", Visibility = J.Str(o, "visibility"),
            DistMinM = J.Int(o, "distMinM"), DistMaxM = J.Int(o, "distMaxM"), StatTotal = J.Int(o, "statTotal"), Awakening = J.Int(o, "awakening"),
            Fee = J.Int(o, "fee"), DailyLimit = J.Int(o, "dailyLimit"), LentToday = J.IntN(o, "lentToday"), ListedAt = J.Long(o, "listedAt"),
            Appearance = Appearance.Parse(J.Opt(o, "appearance")) ?? new Appearance(),
        };
    }

    public sealed class StudHistoryEntry
    {
        public string OpId, Role, OwnerId, BorrowerId, HorseId, HorseName, FoalId;
        public long At;
        /// <summary>Fee charged to the borrower, and what the owner was paid (less when the owner's daily earn cap was reached).</summary>
        public int Fee, Paid;
        public bool Lent => Role == "lent";
        internal static StudHistoryEntry Parse(JsonNode o) => new StudHistoryEntry
        {
            OpId = J.Str(o, "opId"), Role = J.Str(o, "role"), OwnerId = J.Str(o, "ownerId"), BorrowerId = J.Str(o, "borrowerId"),
            HorseId = J.Str(o, "horseId"), HorseName = J.Str(o, "horseName"), FoalId = J.Str(o, "foalId"), At = J.Long(o, "at"),
            Fee = J.Int(o, "fee"), Paid = J.Int(o, "paid"),
        };
    }

    /// <summary>GET /v1/stud/mine: my listings, today's counters, limits and history (newest first).</summary>
    public sealed class StudMine
    {
        public List<StudListing> Listings = new List<StudListing>();
        public int EarnedToday, EarnCap, BorrowedToday, BorrowPerDay;
        public int FeeMax, DailyLimitMax, MaxListings;
        /// <summary>Fees I paid that the owner's side has not confirmed yet (the server retries them).</summary>
        public int PendingPayments;
        public List<StudHistoryEntry> History = new List<StudHistoryEntry>();

        internal static StudMine Parse(JsonNode o)
        {
            var t = J.Opt(o, "today");
            var l = J.Opt(o, "limits");
            return new StudMine
            {
                Listings = J.List(o, "listings", StudListing.Parse),
                EarnedToday = J.Int(t, "earned"), EarnCap = J.Int(t, "earnCap"), BorrowedToday = J.Int(t, "borrowed"), BorrowPerDay = J.Int(t, "borrowPerDay"),
                FeeMax = J.Int(l, "feeMax"), DailyLimitMax = J.Int(l, "dailyLimitMax"), MaxListings = J.Int(l, "maxListings"),
                PendingPayments = J.Int(o, "pendingPayments"), History = J.List(o, "history", StudHistoryEntry.Parse),
            };
        }
    }

    public sealed class StudBrowse
    {
        public string Scope;
        public List<StudListing> Listings = new List<StudListing>();
        internal static StudBrowse Parse(JsonNode o) => new StudBrowse { Scope = J.Str(o, "scope"), Listings = J.List(o, "listings", StudListing.Parse) };
    }

    /// <summary>Stud part of a stud preview: the fee is always FREE coins (paid coins can never pay it).</summary>
    public sealed class StudOffer
    {
        public string OwnerId, HorseId, Name, FeeCurrency;
        public int Fee, Borrowed, BorrowPerDay;
        public int? RemainingToday;
        public bool CanPay;
        internal static StudOffer Parse(JsonNode o) => o == null ? null : new StudOffer
        {
            OwnerId = J.Str(o, "ownerId"), HorseId = J.Str(o, "horseId"), Name = J.Str(o, "name"), FeeCurrency = J.Str(o, "feeCurrency"),
            Fee = J.Int(o, "fee"), Borrowed = J.Int(o, "borrowed"), BorrowPerDay = J.Int(o, "borrowPerDay"), RemainingToday = J.IntN(o, "remainingToday"),
            CanPay = J.Bool(o, "canPay"),
        };
    }

    /// <summary>POST /v1/stud/preview: the normal breeding preview (same functions) plus the offer.</summary>
    public sealed class StudPreview
    {
        public BreedingPreview Breeding;
        public StudOffer Stud;
        internal static StudPreview Parse(JsonNode o) => new StudPreview { Breeding = BreedingPreview.Parse(o), Stud = StudOffer.Parse(J.Opt(o, "stud")) };
    }

    /// <summary>POST /v1/stud/breed. FeeStatus "pending" = the foal is yours and the fee was charged; the owner is paid shortly (server retry).</summary>
    public sealed class StudBreedResult
    {
        public string OpId, OwnerId, HorseId, FeeStatus;
        public int Fee;
        public Horse Foal;
        public bool Nick, UsedMaterial;
        public int InbreedingCount;
        public AtavismTrait Atavism;
        internal static StudBreedResult Parse(JsonNode o) => new StudBreedResult
        {
            OpId = J.Str(o, "opId"), OwnerId = J.Str(o, "ownerId"), HorseId = J.Str(o, "horseId"), FeeStatus = J.Str(o, "feeStatus"),
            Fee = J.Int(o, "fee"), Foal = Horse.Parse(J.Opt(o, "foal")), Nick = J.Bool(o, "nick"), UsedMaterial = J.Bool(o, "usedMaterial"),
            InbreedingCount = J.Int(o, "inbreedingCount"), Atavism = AtavismTrait.Parse(J.Opt(o, "atavism")),
        };
    }

    /// <summary>Limited-time horse marker in an odds row (REQ-BREED-021).</summary>
    public sealed class LimitedInfo
    {
        public string SeasonId, Label;
        public long EndAtMs;
        internal static LimitedInfo Parse(JsonNode o) => o == null ? null : new LimitedInfo { SeasonId = J.Str(o, "seasonId"), Label = J.Str(o, "label"), EndAtMs = J.Long(o, "endAtMs") };
    }
}
