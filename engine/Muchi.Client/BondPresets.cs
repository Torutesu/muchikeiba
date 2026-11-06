using System.Collections.Generic;
using Muchi.Net;

namespace Muchi.Client
{
    /// <summary>One care action of the stable care screen (REQ-BOND-002).</summary>
    public sealed class CareAction
    {
        public string Id, Focus;
        public int Points;
        public long CooldownMs, ReadyAt;
        /// <summary>Can be done now (cooldown over and today's limit not reached).</summary>
        public bool Ready;

        internal static CareAction Parse(JsonNode o) => new CareAction
        {
            Id = J.Str(o, "id"), Focus = J.Str(o, "focus"), Points = J.Int(o, "points"),
            CooldownMs = J.Long(o, "cooldownMs"), ReadyAt = J.Long(o, "readyAt"), Ready = J.Bool(o, "ready"),
        };
    }

    /// <summary>Bond (絆) of one horse. Never changes ranked, event or time attack stats (REQ-BOND-005).</summary>
    public sealed class BondView
    {
        public string HorseId, Focus;
        public int Level, Points, MaxLevel, TodayActions, DailyActions;
        public int? NextLevelAt;
        public bool CommentaryCallout, AffectsRankedStats;
        public List<CareAction> Actions = new List<CareAction>();

        internal static BondView Parse(JsonNode o) => new BondView
        {
            HorseId = J.Str(o, "horseId"), Focus = J.Str(o, "focus"), Level = J.Int(o, "level", 1), Points = J.Int(o, "points"),
            MaxLevel = J.Int(o, "maxLevel"), TodayActions = J.Int(o, "todayActions"), DailyActions = J.Int(o, "dailyActions"),
            NextLevelAt = J.IntN(o, "nextLevelAt"), CommentaryCallout = J.Bool(o, "commentaryCallout"), AffectsRankedStats = J.Bool(o, "affectsRankedStats"),
            Actions = J.List(o, "actions", CareAction.Parse),
        };
    }

    public sealed class CareResult
    {
        public int Gained;
        public bool LevelUp;
        /// <summary>Account-wide level rewards paid by this care (once per player per level).</summary>
        public List<Reward> Rewards = new List<Reward>();
        public List<string> Titles = new List<string>();
        public BondView Bond;

        internal static CareResult Parse(JsonNode o) => new CareResult
        {
            Gained = J.Int(o, "gained"), LevelUp = J.Bool(o, "levelUp"),
            Rewards = J.List(o, "rewards", x => Reward.Parse(J.Opt(x, "reward"))), Titles = J.List(o, "titles", x => x.AsString()),
            Bond = BondView.Parse(J.Opt(o, "bond")),
        };
    }

    /// <summary>
    /// Private-room conditions (REQ-ROOM-002). Course / going / night go into the race config of the host's friend
    /// rooms; weather, temperature and wind are scene only. Null fields mean "automatic" (the day's ground etc.).
    /// </summary>
    public sealed class RoomConditions
    {
        public string TrackId, Going;
        public bool? Night;
        public string Weather = "sunny";
        public int TemperatureC = 18, WindKmh;

        internal static RoomConditions Parse(JsonNode o)
        {
            if (o == null || o.Kind != JsonKind.Object) return null;
            var n = J.Opt(o, "night");
            return new RoomConditions
            {
                TrackId = J.Str(o, "trackId"), Going = J.Str(o, "going"), Night = n == null ? (bool?)null : n.AsBool(),
                Weather = J.Str(o, "weather") ?? "sunny", TemperatureC = J.Int(o, "temperatureC", 18), WindKmh = J.Int(o, "windKmh"),
            };
        }

        internal JsonNode ToJson()
        {
            var b = JsonNode.Obj();
            b.Set("trackId", TrackId == null ? JsonNode.Null() : JsonNode.Str(TrackId));
            b.Set("going", Going == null ? JsonNode.Null() : JsonNode.Str(Going));
            b.Set("night", Night.HasValue ? JsonNode.Bool(Night.Value) : JsonNode.Null());
            b.Set("weather", Weather);
            b.Set("temperatureC", TemperatureC);
            b.Set("windKmh", WindKmh);
            return b;
        }
    }

    /// <summary>Course look and private-room presets stored on the server (REQ-ROOM-*).</summary>
    public sealed class Presets
    {
        public string CourseLook, CourseLookKey;
        public List<string> OwnedCourseLooks = new List<string>();
        public RoomConditions Room;

        internal static Presets Parse(JsonNode o) => new Presets
        {
            CourseLook = J.Str(o, "courseLook"), CourseLookKey = J.Str(o, "courseLookKey"),
            OwnedCourseLooks = J.List(o, "ownedCourseLooks", x => x.AsString()), Room = RoomConditions.Parse(J.Opt(o, "room")),
        };
    }
}
