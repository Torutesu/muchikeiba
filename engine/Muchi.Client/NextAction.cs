using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-NEXT-001..014 次にやること — the home's next card (server/src/domain/nextAction.ts, contracts/protocol.md §45).
    // The server chooses (a pure function of the player's state, priorities in progression.nextActions). The client only
    // draws it, and offline falls back to the last list it received (NextActionFallback, §45.6). Deadlines are real times
    // from data (shown as a date and time, never a countdown); no kind opens the shop.

    /// <summary>The kinds and their fixed rules (mirrors server/src/domain/nextKinds.ts and nextAction.ts).</summary>
    public static class NextKinds
    {
        public static readonly string[] All =
        {
            "first_race", "login_bonus", "missions_claim", "pass_claim", "gift_expiring", "training_open", "missions_close", "exchange_closing",
            "feature_unlocked", "rival_week", "weekly_challenge", "team_goal_near", "horse_goal_near", "training_slots", "first_win", "scout_ticket", "race",
        };
        public static readonly string[] Slots = { "primary", "chip" };
        /// <summary>Never the primary card (REQ-NEXT-003).</summary>
        public static bool ChipOnly(string kind) => kind == "scout_ticket";
        /// <summary>Always available, so never closed (REQ-NEXT-005).</summary>
        public static bool Dismissible(string kind) => kind != "first_race" && kind != "race";
        public static bool Known(string kind) => Array.IndexOf(All, kind) >= 0;
    }

    /// <summary>One card (primary or chip).</summary>
    public sealed class NextItem
    {
        public string Kind, Screen, FeatureKey, RefId;
        public int? Count;
        /// <summary>A real time from data (gift expiry, exchange close, the week's end, an open training session), or null.</summary>
        public long? DeadlineAt;
        public bool Dismissible;
        internal static NextItem Parse(JsonNode o) => o == null ? null : new NextItem
        {
            Kind = J.Str(o, "kind"), Screen = J.Str(o, "screen"), FeatureKey = J.Str(o, "featureKey"), RefId = J.Str(o, "refId"),
            Count = J.IntN(o, "count"), DeadlineAt = J.LongN(o, "deadlineAt"), Dismissible = J.Bool(o, "dismissible"),
        };
        /// <summary>The fallback card (always there, never closed).</summary>
        public static NextItem Race() => new NextItem { Kind = "race", Screen = "race", Dismissible = false };
    }

    /// <summary>GET /v1/home/next, POST /v1/home/next/dismiss, and <c>nextActions</c> of the player view.</summary>
    public sealed class NextActionsView
    {
        public bool Enabled, Onboarding;
        /// <summary>The game day this list was computed for ("YYYY-MM-DD").</summary>
        public string Day;
        public NextItem Primary;
        public List<NextItem> Chips = new List<NextItem>();
        /// <summary>Kinds closed for <see cref="Day"/>.</summary>
        public List<string> Dismissed = new List<string>();
        /// <summary>Start of the next game day (when closed kinds come back). Not for display.</summary>
        public long NextDayAt;
        /// <summary>True when built by <see cref="NextActionFallback"/> (no server answer).</summary>
        public bool FromCache;

        internal static NextActionsView Parse(JsonNode o) => o == null ? null : new NextActionsView
        {
            Enabled = J.Bool(o, "enabled"), Onboarding = J.Bool(o, "onboarding"), Day = J.Str(o, "day"), Primary = NextItem.Parse(J.Opt(o, "primary")),
            Chips = J.List(o, "chips", NextItem.Parse), Dismissed = J.List(o, "dismissed", x => x.AsString()), NextDayAt = J.Long(o, "nextDayAt"),
        };

        /// <summary>The JSON to keep for the offline fallback (the same shape the server sends).</summary>
        public string ToJson()
        {
            JsonNode Item(NextItem i)
            {
                if (i == null) return JsonNode.Null();
                return JsonNode.Obj().Set("kind", i.Kind).Set("screen", i.Screen).Set("dismissible", i.Dismissible)
                    .Set("count", i.Count.HasValue ? JsonNode.Num(i.Count.Value) : JsonNode.Null())
                    .Set("deadlineAt", i.DeadlineAt.HasValue ? JsonNode.Num(i.DeadlineAt.Value) : JsonNode.Null())
                    .Set("featureKey", i.FeatureKey).Set("refId", i.RefId);
            }
            var chips = JsonNode.Arr();
            foreach (var c in Chips) chips.Add(Item(c));
            var dis = JsonNode.Arr();
            foreach (var d in Dismissed) dis.Add(JsonNode.Str(d));
            return JsonNode.Obj().Set("enabled", Enabled).Set("onboarding", Onboarding).Set("day", Day ?? "").Set("primary", Item(Primary))
                .Set("chips", chips).Set("dismissed", dis).Set("nextDayAt", NextDayAt).ToString();
        }

        public static NextActionsView FromJson(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            try { return Parse(JsonNode.Parse(json)); } catch (FormatException) { return null; }
        }
    }

    /// <summary>
    /// REQ-NEXT §45.6: what to show without a server answer. From the last list received: drop cards whose deadline has passed
    /// and kinds closed on this device today; on another game day than the list's, only the race card (yesterday's reasons are
    /// stale). Nothing cached = the race card. Never invents a card the server did not send.
    /// </summary>
    public static class NextActionFallback
    {
        public static NextActionsView Offline(NextActionsView cached, long nowMs, DayRolloverInfo rule, ICollection<string> closedToday = null)
        {
            string today = (rule ?? new DayRolloverInfo()).Key(nowMs);
            var view = new NextActionsView { Enabled = cached?.Enabled ?? true, Day = today, FromCache = true, Primary = NextItem.Race() };
            if (cached == null || !cached.Enabled) { view.Primary = cached != null && !cached.Enabled ? null : view.Primary; return view; }
            if (cached.Day != today) return view;
            view.Onboarding = cached.Onboarding;
            view.Dismissed = new List<string>(cached.Dismissed);
            if (closedToday != null) foreach (var k in closedToday) if (!view.Dismissed.Contains(k)) view.Dismissed.Add(k);
            bool keep(NextItem i) => i != null && (i.DeadlineAt == null || i.DeadlineAt.Value > nowMs) && !(i.Dismissible && view.Dismissed.Contains(i.Kind));
            var list = new List<NextItem>();
            if (keep(cached.Primary)) list.Add(cached.Primary);
            foreach (var c in cached.Chips) if (keep(c)) list.Add(c);
            NextItem primary = list.Find(i => !NextKinds.ChipOnly(i.Kind));
            view.Primary = primary ?? NextItem.Race();
            foreach (var c in list) if (c != primary && c.Kind != "race" && view.Chips.Count < 2) view.Chips.Add(c);
            return view;
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-NEXT-010: the home's next card and chips (the team goal included when in a team).</summary>
        public Task<NextActionsView> GetNextActionsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/home/next", null, true, null, true, NextActionsView.Parse, ct);

        /// <summary>
        /// REQ-NEXT-005: close a kind for today's game day (idempotent; safe to retry). ConflictException NOT_ELIGIBLE for
        /// first_race / race; ArgumentException for an unknown kind (never sent).
        /// </summary>
        public Task<NextActionsView> DismissNextActionAsync(string kind, CancellationToken ct = default)
        {
            if (!NextKinds.Known(kind)) throw new ArgumentException("unknown next action " + kind, nameof(kind));
            return Call("POST", "/v1/home/next/dismiss", JsonNode.Obj().Set("kind", kind), true, null, true, NextActionsView.Parse, ct);
        }
    }

    public sealed partial class AnalyticsEvent
    {
        /// <summary>REQ-NEXT-012: a next card was put on screen (send once per kind and game day). slot: primary | chip.</summary>
        public static AnalyticsEvent NextCardView(long atMs, string kind, string slot) => NextCard("next_card_view", atMs, kind, slot);
        /// <summary>REQ-NEXT-012: the player tapped a next card.</summary>
        public static AnalyticsEvent NextCardTap(long atMs, string kind, string slot) => NextCard("next_card_tap", atMs, kind, slot);

        private static AnalyticsEvent NextCard(string name, long atMs, string kind, string slot)
        {
            if (!NextKinds.Known(kind)) throw new ArgumentException("unknown next action " + kind);
            if (Array.IndexOf(NextKinds.Slots, slot) < 0) throw new ArgumentException("unknown slot " + slot);
            return new AnalyticsEvent(name, atMs, JsonNode.Obj().Set("kind", kind).Set("slot", slot));
        }
    }
}
