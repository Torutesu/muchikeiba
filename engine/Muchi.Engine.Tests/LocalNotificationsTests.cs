using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-LNOTIF-001..020: 端末のローカル通知 — the shared plan (contracts/local-notifications.vectors.json), the diff, the digest and the KPI (protocol §61).</summary>
    public class LocalNotificationsTests
    {
        private static JsonNode Get(JsonNode o, string k) { Assert.True(o.TryGet(k, out var x), k); return x; }

        private static LocalNotificationPermission Perm(string s) => s switch
        {
            "granted" => LocalNotificationPermission.Granted, "provisional" => LocalNotificationPermission.Provisional,
            "denied" => LocalNotificationPermission.Denied, _ => LocalNotificationPermission.Unknown,
        };

        private static LocalNotificationSnapshot Snapshot(JsonNode s)
        {
            var x = new LocalNotificationSnapshot
            {
                Now = Get(s, "now").AsLong(), Locale = Get(s, "locale").AsString(), Permission = Perm(Get(s, "permission").AsString()),
                ShowDetails = Get(s, "showDetails").AsBool(), SignedIn = Get(s, "signedIn").AsBool(),
                Digest = s.TryGet("digest", out var d) && !d.IsNull ? LocalRemindersDigest.Parse(d) : null,
            };
            if (s.TryGet("horseNames", out var hn) && !hn.IsNull) foreach (var kv in hn.Props) x.HorseNames[kv.Key] = kv.Value.AsString();
            return x;
        }

        private static JsonNode Vectors() => JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "local-notifications.vectors.json")));

        [Fact]
        public void PlanMatchesTheServerVectors()
        {
            int n = 0;
            foreach (var c in Get(Vectors(), "cases").Items)
            {
                string name = Get(c, "name").AsString();
                var got = LocalNotificationPlanner.Plan(Snapshot(Get(c, "snapshot")));
                var e = Get(c, "expect");
                Assert.True(Get(e, "status").AsString() == got.Status, name + " status " + got.Status);
                var items = Get(e, "items").Items;
                Assert.True(items.Count == got.Items.Count, name + " items " + got.Items.Count + " vs " + items.Count);
                for (int i = 0; i < items.Count; i++)
                {
                    var x = items[i]; var g = got.Items[i];
                    string refId = Get(x, "refId").IsNull ? null : Get(x, "refId").AsString();
                    Assert.True(Get(x, "id").AsString() == g.Id && Get(x, "kind").AsString() == g.Kind && Get(x, "category").AsString() == g.Category
                        && Get(x, "fireAt").AsLong() == g.FireAt && Get(x, "screen").AsString() == g.Screen && refId == g.RefId, name + " #" + i + " " + g.Id);
                    Assert.Equal(Get(x, "title").AsString(), g.Title);
                    Assert.Equal(Get(x, "body").AsString(), g.Body);
                }
                var dropped = Get(e, "dropped").Items.Select(x => Get(x, "id").AsString() + ":" + Get(x, "reason").AsString()).ToList();
                Assert.Equal(dropped, got.Dropped.Select(x => x.Id + ":" + x.Reason).ToList());
                n++;
            }
            Assert.True(n >= 25);
        }

        [Fact]
        public void DiffReschedulesOnlyChangesAndCountsNewIdsOnce()
        {
            var c = Get(Vectors(), "cases").Items.First(x => Get(x, "name").AsString() == "everything, ja");
            var snap = Snapshot(Get(c, "snapshot"));
            var a = LocalNotificationPlanner.Plan(snap).Items;
            var prev = a.ToDictionary(i => i.Id, i => i.Fingerprint);
            var same = LocalNotificationPlanner.Diff(prev, a);
            Assert.Empty(same.Cancel); Assert.Empty(same.Schedule); Assert.Empty(same.Added);
            // training finished early: its reminder goes
            snap.Digest.TrainingSessionId = null; snap.Digest.TrainingExpiresAt = null;
            var b = LocalNotificationPlanner.Diff(prev, LocalNotificationPlanner.Plan(snap).Items);
            Assert.Equal(new[] { "lnotif.training_session.ts1" }, b.Cancel);
            Assert.Empty(b.Added);
            // English: same ids, new texts → re-scheduled, not new
            snap.Locale = "en";
            var e = LocalNotificationPlanner.Diff(prev, LocalNotificationPlanner.Plan(snap).Items);
            Assert.Empty(e.Added);
            Assert.True(e.Schedule.Count > 0 && e.Schedule.All(i => prev.ContainsKey(i.Id)));
            Assert.Empty(LocalNotificationPlanner.Diff(null, new List<LocalNotificationItem>()).Cancel);
        }

        [Fact]
        public void DigestParsesTheBootstrapAndOlderServers()
        {
            var json = "{\"localReminders\":{\"v\":1,\"enabled\":true,\"now\":1,\"nextDayAt\":2,\"config\":{\"kinds\":[\"daily_bonus\"],\"dailyCap\":2,\"dailyHourJst\":12,\"horizonDays\":7,\"maxPending\":8,\"trainingLeadMin\":3,"
                + "\"leadHours\":{\"gift_expiring\":24},\"prePrompt\":{\"maxAsks\":2,\"retryDays\":14}},\"categories\":{\"reminders\":false,\"gifts\":true},\"quietHours\":null,\"deleting\":false,\"onboarding\":false,"
                + "\"loginBonus\":{\"unlocked\":true},\"training\":{\"sessionId\":null,\"horseId\":null,\"expiresAt\":null,\"trainedEver\":false},\"weeklyChallenge\":null,\"rival\":null,\"exchanges\":[],\"gifts\":[5]}}";
            var d = LocalRemindersDigest.Parse(Get(JsonNode.Parse(json), "localReminders"));
            Assert.True(d.Enabled && d.LoginBonusUnlocked && !d.TrainedEver && d.QuietStartHour == null && d.WeeklyChallenge == null);
            Assert.False(d.CategoryOn("reminders"));
            Assert.True(d.CategoryOn("gifts"));
            Assert.Equal(new long[] { 5 }, d.Gifts);
            Assert.Equal(2, d.PrePromptMaxAsks);
            Assert.False(LocalRemindersDigest.Parse(JsonNode.Parse("{\"v\":1,\"enabled\":false}")).Enabled);
            Assert.Null(LocalRemindersDigest.Parse(null));
            Assert.Equal("off", LocalNotificationPlanner.Plan(new LocalNotificationSnapshot { SignedIn = true, Digest = null }).Status);
        }

        [Fact]
        public void TextsAreCleanAndEveryKindHasACategoryAndAScreen()
        {
            var banned = new[] { "倍", "今だけ", "残りわずか", "お得", "通常価格", "¥", "hurry", "only now", "last chance", "sale", "odds", "bet " };
            foreach (var t in LocalNotificationPlanner.AllTexts())
                foreach (var w in banned) Assert.False(t.ToLowerInvariant().Contains(w.ToLowerInvariant()), t + " has " + w);
            foreach (var k in LocalNotificationPlanner.Kinds)
            {
                Assert.Contains(LocalNotificationPlanner.KindCategory[k], new[] { "reminders", "events", "friends", "gifts" });
                Assert.DoesNotContain(LocalNotificationPlanner.KindScreen[k], new[] { "shop", "season_pass", "scout", "gacha" });
            }
        }

        [Fact]
        public void PushPreferencesCarryTheRemindersCategory()
        {
            var patch = new PushPreferencesPatch { Reminders = true };
            var m = typeof(PushPreferencesPatch).GetMethod("ToJson", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
            Assert.Equal("{\"categories\":{\"reminders\":true}}", m.Invoke(patch, null)!.ToString());
        }

        [Fact]
        public void AnalyticsEventsValidateKindsAndResults()
        {
            Assert.Equal("{\"kind\":\"gift_expiring\"}", AnalyticsEvent.LocalNotificationScheduled(1, "gift_expiring").PropsJson);
            Assert.Equal("lnotif_opened", AnalyticsEvent.LocalNotificationOpened(1, "daily_bonus").Name);
            Assert.Equal("{\"result\":\"later\"}", AnalyticsEvent.LocalNotificationPermissionResult(1, "later").PropsJson);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.LocalNotificationScheduled(1, "shop_offer"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.LocalNotificationPermissionResult(1, "maybe"));
        }
    }
}
