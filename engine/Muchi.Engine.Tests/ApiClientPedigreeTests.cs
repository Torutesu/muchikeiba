using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-PED-001..020: pedigree / breeding pair / bloodline client methods, models and KPI rows (contracts/protocol.md §71).</summary>
    public class ApiClientPedigreeTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientPedigreeTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (pedigree.ts finishPedigree / finishBreedingPedigree / bloodlinesView: a brother x sister
        // bred from t_akatsuki x t_kohaku)
        internal const string View = "{\"key\":\"h3\",\"name\":\"アカツキボーイ\",\"horseId\":\"h3\",\"sire\":{\"key\":\"h1\",\"name\":\"シンセイアカツキ\",\"horseId\":\"h1\",\"sire\":{\"key\":\"name:アカツキオー\",\"name\":\"アカツキオー\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":2,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":false,\"founder\":true},\"dam\":{\"key\":\"name:ハツユキヒメ\",\"name\":\"ハツユキヒメ\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":2,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":false,\"founder\":false},\"gen\":1,\"rec\":{\"source\":\"live\",\"rarity\":\"SSR\",\"sex\":\"male\",\"style\":\"sashi\",\"goingAptitude\":\"any\",\"surface\":\"turf\",\"line\":\"akatsuki\",\"lineName\":\"アカツキ系\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"sock\",\"none\",\"sock\"],\"mane\":\"flaxen\",\"build\":\"rangy\"},\"thumbKey\":\"collection/portrait/t_akatsuki\",\"skill\":{\"id\":\"sk_kireaji\",\"name\":\"切れ味鋭く\"},\"status\":\"retired\",\"statTotal\":3590,\"stats\":{\"speed\":820,\"stamina\":700,\"burst\":900,\"guts\":650,\"temper\":520},\"best\":{\"races\":0,\"wins\":0,\"places\":0,\"tournamentWins\":0},\"bestText\":\"出走なし\"},\"recordText\":null,\"shared\":false,\"founder\":false},\"dam\":{\"key\":\"h2\",\"name\":\"コハクノヒカリ\",\"horseId\":\"h2\",\"sire\":{\"key\":\"name:ハヤテマル\",\"name\":\"ハヤテマル\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":2,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":false,\"founder\":true},\"dam\":{\"key\":\"name:ヒカリノミチ\",\"name\":\"ヒカリノミチ\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":2,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":false,\"founder\":false},\"gen\":1,\"rec\":{\"source\":\"live\",\"rarity\":\"SSR\",\"sex\":\"female\",\"style\":\"nige\",\"goingAptitude\":\"fast\",\"surface\":\"turf\",\"line\":\"hayate\",\"lineName\":\"ハヤテ系\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"star\",\"legs\":[\"coronet\",\"none\",\"none\",\"none\"],\"mane\":\"normal\",\"build\":\"compact\"},\"thumbKey\":\"collection/portrait/t_kohaku\",\"skill\":{\"id\":\"sk_shippu\",\"name\":\"疾風の先駆け\"},\"status\":\"retired\",\"statTotal\":3460,\"stats\":{\"speed\":860,\"stamina\":640,\"burst\":700,\"guts\":780,\"temper\":480},\"best\":{\"races\":0,\"wins\":0,\"places\":0,\"tournamentWins\":0},\"bestText\":\"出走なし\"},\"recordText\":null,\"shared\":false,\"founder\":false},\"gen\":0,\"rec\":{\"source\":\"live\",\"rarity\":\"SR\",\"sex\":\"male\",\"style\":\"nige\",\"goingAptitude\":\"any\",\"surface\":\"turf\",\"line\":\"akatsuki\",\"lineName\":\"アカツキ系\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"coronet\",\"sock\",\"none\",\"sock\"],\"mane\":\"flaxen\",\"build\":\"rangy\"},\"thumbKey\":null,\"skill\":{\"id\":\"sk_kireaji\",\"name\":\"切れ味鋭く\"},\"status\":\"retired\",\"statTotal\":3300,\"stats\":{\"speed\":786,\"stamina\":600,\"burst\":794,\"guts\":625,\"temper\":495},\"best\":{\"races\":0,\"wins\":0,\"places\":0,\"tournamentWins\":0},\"bestText\":\"出走なし\"},\"recordText\":null,\"shared\":false,\"founder\":false,\"v\":2,\"relation\":\"self\",\"generations\":5,\"line\":\"akatsuki\",\"lineName\":\"アカツキ系\",\"sharedKeys\":[],\"inbreeding\":{\"count\":0,\"penaltyPerAncestor\":50,\"statPenalty\":0},\"young\":false,\"rev\":\"aeca64b461ac3715\"}";
        internal const string Pair = "{\"sire\":{\"key\":\"h3\",\"name\":\"アカツキボーイ\",\"horseId\":\"h3\",\"sire\":{\"key\":\"h1\",\"name\":\"シンセイアカツキ\",\"horseId\":\"h1\",\"sire\":{\"key\":\"name:アカツキオー\",\"name\":\"アカツキオー\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":3,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":true,\"founder\":true},\"dam\":{\"key\":\"name:ハツユキヒメ\",\"name\":\"ハツユキヒメ\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":3,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":true,\"founder\":false},\"gen\":2,\"rec\":{\"source\":\"live\",\"rarity\":\"SSR\",\"sex\":\"male\",\"style\":\"sashi\",\"goingAptitude\":\"any\",\"surface\":\"turf\",\"line\":\"akatsuki\",\"lineName\":\"アカツキ系\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"sock\",\"none\",\"sock\"],\"mane\":\"flaxen\",\"build\":\"rangy\"},\"thumbKey\":\"collection/portrait/t_akatsuki\",\"skill\":{\"id\":\"sk_kireaji\",\"name\":\"切れ味鋭く\"},\"status\":\"retired\",\"statTotal\":3590,\"stats\":{\"speed\":820,\"stamina\":700,\"burst\":900,\"guts\":650,\"temper\":520},\"best\":{\"races\":0,\"wins\":0,\"places\":0,\"tournamentWins\":0},\"bestText\":\"出走なし\"},\"recordText\":null,\"shared\":true,\"founder\":false},\"dam\":{\"key\":\"h2\",\"name\":\"コハクノヒカリ\",\"horseId\":\"h2\",\"sire\":{\"key\":\"name:ハヤテマル\",\"name\":\"ハヤテマル\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":3,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":true,\"founder\":true},\"dam\":{\"key\":\"name:ヒカリノミチ\",\"name\":\"ヒカリノミチ\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":3,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":true,\"founder\":false},\"gen\":2,\"rec\":{\"source\":\"live\",\"rarity\":\"SSR\",\"sex\":\"female\",\"style\":\"nige\",\"goingAptitude\":\"fast\",\"surface\":\"turf\",\"line\":\"hayate\",\"lineName\":\"ハヤテ系\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"star\",\"legs\":[\"coronet\",\"none\",\"none\",\"none\"],\"mane\":\"normal\",\"build\":\"compact\"},\"thumbKey\":\"collection/portrait/t_kohaku\",\"skill\":{\"id\":\"sk_shippu\",\"name\":\"疾風の先駆け\"},\"status\":\"retired\",\"statTotal\":3460,\"stats\":{\"speed\":860,\"stamina\":640,\"burst\":700,\"guts\":780,\"temper\":480},\"best\":{\"races\":0,\"wins\":0,\"places\":0,\"tournamentWins\":0},\"bestText\":\"出走なし\"},\"recordText\":null,\"shared\":true,\"founder\":false},\"gen\":1,\"rec\":{\"source\":\"live\",\"rarity\":\"SR\",\"sex\":\"male\",\"style\":\"nige\",\"goingAptitude\":\"any\",\"surface\":\"turf\",\"line\":\"akatsuki\",\"lineName\":\"アカツキ系\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"coronet\",\"sock\",\"none\",\"sock\"],\"mane\":\"flaxen\",\"build\":\"rangy\"},\"thumbKey\":null,\"skill\":{\"id\":\"sk_kireaji\",\"name\":\"切れ味鋭く\"},\"status\":\"retired\",\"statTotal\":3300,\"stats\":{\"speed\":786,\"stamina\":600,\"burst\":794,\"guts\":625,\"temper\":495},\"best\":{\"races\":0,\"wins\":0,\"places\":0,\"tournamentWins\":0},\"bestText\":\"出走なし\"},\"recordText\":null,\"shared\":false,\"founder\":false},\"dam\":{\"key\":\"h4\",\"name\":\"ミメイ\",\"horseId\":\"h4\",\"sire\":{\"key\":\"h1\",\"name\":\"シンセイアカツキ\",\"horseId\":\"h1\",\"sire\":{\"key\":\"name:アカツキオー\",\"name\":\"アカツキオー\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":3,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":true,\"founder\":true},\"dam\":{\"key\":\"name:ハツユキヒメ\",\"name\":\"ハツユキヒメ\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":3,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":true,\"founder\":false},\"gen\":2,\"rec\":{\"source\":\"live\",\"rarity\":\"SSR\",\"sex\":\"male\",\"style\":\"sashi\",\"goingAptitude\":\"any\",\"surface\":\"turf\",\"line\":\"akatsuki\",\"lineName\":\"アカツキ系\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"blaze\",\"legs\":[\"none\",\"sock\",\"none\",\"sock\"],\"mane\":\"flaxen\",\"build\":\"rangy\"},\"thumbKey\":\"collection/portrait/t_akatsuki\",\"skill\":{\"id\":\"sk_kireaji\",\"name\":\"切れ味鋭く\"},\"status\":\"retired\",\"statTotal\":3590,\"stats\":{\"speed\":820,\"stamina\":700,\"burst\":900,\"guts\":650,\"temper\":520},\"best\":{\"races\":0,\"wins\":0,\"places\":0,\"tournamentWins\":0},\"bestText\":\"出走なし\"},\"recordText\":null,\"shared\":true,\"founder\":false},\"dam\":{\"key\":\"h2\",\"name\":\"コハクノヒカリ\",\"horseId\":\"h2\",\"sire\":{\"key\":\"name:ハヤテマル\",\"name\":\"ハヤテマル\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":3,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":true,\"founder\":true},\"dam\":{\"key\":\"name:ヒカリノミチ\",\"name\":\"ヒカリノミチ\",\"horseId\":null,\"sire\":null,\"dam\":null,\"gen\":3,\"rec\":null,\"recordText\":\"記録なし\",\"shared\":true,\"founder\":false},\"gen\":2,\"rec\":{\"source\":\"live\",\"rarity\":\"SSR\",\"sex\":\"female\",\"style\":\"nige\",\"goingAptitude\":\"fast\",\"surface\":\"turf\",\"line\":\"hayate\",\"lineName\":\"ハヤテ系\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"star\",\"legs\":[\"coronet\",\"none\",\"none\",\"none\"],\"mane\":\"normal\",\"build\":\"compact\"},\"thumbKey\":\"collection/portrait/t_kohaku\",\"skill\":{\"id\":\"sk_shippu\",\"name\":\"疾風の先駆け\"},\"status\":\"retired\",\"statTotal\":3460,\"stats\":{\"speed\":860,\"stamina\":640,\"burst\":700,\"guts\":780,\"temper\":480},\"best\":{\"races\":0,\"wins\":0,\"places\":0,\"tournamentWins\":0},\"bestText\":\"出走なし\"},\"recordText\":null,\"shared\":true,\"founder\":false},\"gen\":1,\"rec\":{\"source\":\"live\",\"rarity\":\"SR\",\"sex\":\"female\",\"style\":\"sashi\",\"goingAptitude\":\"any\",\"surface\":\"turf\",\"line\":\"akatsuki\",\"lineName\":\"アカツキ系\",\"appearance\":{\"coat\":\"chestnut\",\"face\":\"star\",\"legs\":[\"none\",\"sock\",\"none\",\"sock\"],\"mane\":\"normal\",\"build\":\"rangy\"},\"thumbKey\":null,\"skill\":null,\"status\":\"retired\",\"statTotal\":3401,\"stats\":{\"speed\":830,\"stamina\":662,\"burst\":710,\"guts\":682,\"temper\":517},\"best\":{\"races\":0,\"wins\":0,\"places\":0,\"tournamentWins\":0},\"bestText\":\"出走なし\"},\"recordText\":null,\"shared\":false,\"founder\":false},\"sharedKeys\":[\"h1\",\"name:アカツキオー\",\"name:ハツユキヒメ\",\"h2\",\"name:ハヤテマル\",\"name:ヒカリノミチ\"],\"shared\":[{\"key\":\"h1\",\"name\":\"シンセイアカツキ\"},{\"key\":\"name:アカツキオー\",\"name\":\"アカツキオー\"},{\"key\":\"name:ハツユキヒメ\",\"name\":\"ハツユキヒメ\"},{\"key\":\"h2\",\"name\":\"コハクノヒカリ\"},{\"key\":\"name:ハヤテマル\",\"name\":\"ハヤテマル\"},{\"key\":\"name:ヒカリノミチ\",\"name\":\"ヒカリノミチ\"}],\"inbreeding\":{\"count\":6,\"penaltyPerAncestor\":50,\"statPenalty\":300},\"nick\":{\"on\":false,\"bonus\":0},\"hints\":[{\"kind\":\"line\",\"hintText\":\"仔の系統は父と同じ「アカツキ系」\"},{\"kind\":\"stat\",\"hintText\":\"スピードが受け継がれやすい（407〜527）\",\"value\":527},{\"kind\":\"stat\",\"hintText\":\"瞬発力が受け継がれやすい（354〜474）\",\"value\":474},{\"kind\":\"style\",\"hintText\":\"脚質「逃げ」になる確率 47.5%\",\"permille\":475},{\"kind\":\"style\",\"hintText\":\"脚質「差し」になる確率 47.5%\",\"permille\":475},{\"kind\":\"skill\",\"hintText\":\"固有スキル「切れ味鋭く」を受け継ぐ確率 30%\",\"permille\":300},{\"kind\":\"atavism\",\"hintText\":\"隔世遺伝：コハクノヒカリの「良馬場が得意」 4%\",\"permille\":40},{\"kind\":\"inbreeding\",\"hintText\":\"近親：共通の祖先6頭（能力の基準 −300）\",\"value\":6}],\"line\":{\"id\":\"akatsuki\",\"lineName\":\"アカツキ系\"},\"notice\":\"確率と数は配合の規則のとおりです。\"}";
        internal const string Lines = "{\"lines\":[{\"id\":\"akatsuki\",\"lineName\":\"アカツキ系\",\"founderName\":\"アカツキオー\",\"note\":\"夜明けの直線で伸びる芝の系統。差し・追込の馬が多い。\",\"count\":7,\"active\":4,\"retired\":3,\"nickWith\":[{\"id\":\"minamo\",\"lineName\":\"ミナモ系\",\"role\":\"dam\",\"bonus\":30},{\"id\":\"hayate\",\"lineName\":\"ハヤテ系\",\"role\":\"sire\",\"bonus\":30}],\"horses\":[{\"horseId\":\"h1\",\"name\":\"シンセイアカツキ\",\"sex\":\"male\",\"status\":\"retired\",\"rarity\":\"SSR\"},{\"horseId\":\"h3\",\"name\":\"アカツキボーイ\",\"sex\":\"male\",\"status\":\"retired\",\"rarity\":\"SR\"},{\"horseId\":\"h4\",\"name\":\"ミメイ\",\"sex\":\"female\",\"status\":\"retired\",\"rarity\":\"SR\"},{\"horseId\":\"h5\",\"name\":\"ミメイ\",\"sex\":\"female\",\"status\":\"active\",\"rarity\":\"SR\"},{\"horseId\":\"h6\",\"name\":\"ミメイ\",\"sex\":\"female\",\"status\":\"active\",\"rarity\":\"SR\"},{\"horseId\":\"h7\",\"name\":\"ミメイ\",\"sex\":\"female\",\"status\":\"active\",\"rarity\":\"SR\"},{\"horseId\":\"h8\",\"name\":\"ミメイ\",\"sex\":\"female\",\"status\":\"active\",\"rarity\":\"SR\"}]},{\"id\":\"hoshi\",\"lineName\":\"ホシ系\",\"founderName\":\"ホシノオウ\",\"note\":\"長い距離で粘る芝の系統。先行の馬が多い。\",\"count\":0,\"active\":0,\"retired\":0,\"nickWith\":[{\"id\":\"hayate\",\"lineName\":\"ハヤテ系\",\"role\":\"dam\",\"bonus\":30},{\"id\":\"minamo\",\"lineName\":\"ミナモ系\",\"role\":\"sire\",\"bonus\":30}],\"horses\":[]},{\"id\":\"hayate\",\"lineName\":\"ハヤテ系\",\"founderName\":\"ハヤテマル\",\"note\":\"スタートから飛ばす芝の系統。逃げの馬が多い。\",\"count\":1,\"active\":0,\"retired\":1,\"nickWith\":[{\"id\":\"akatsuki\",\"lineName\":\"アカツキ系\",\"role\":\"dam\",\"bonus\":30},{\"id\":\"hoshi\",\"lineName\":\"ホシ系\",\"role\":\"sire\",\"bonus\":30}],\"horses\":[{\"horseId\":\"h2\",\"name\":\"コハクノヒカリ\",\"sex\":\"female\",\"status\":\"retired\",\"rarity\":\"SSR\"}]},{\"id\":\"minamo\",\"lineName\":\"ミナモ系\",\"founderName\":\"ミナモノオウジ\",\"note\":\"重い馬場にも強い芝の系統。脚質はさまざま。\",\"count\":0,\"active\":0,\"retired\":0,\"nickWith\":[{\"id\":\"hoshi\",\"lineName\":\"ホシ系\",\"role\":\"dam\",\"bonus\":30},{\"id\":\"akatsuki\",\"lineName\":\"アカツキ系\",\"role\":\"sire\",\"bonus\":30}],\"horses\":[]},{\"id\":\"sunaarashi\",\"lineName\":\"スナアラシ系\",\"founderName\":\"サバクノオウ\",\"note\":\"ダートで前に行く系統。\",\"count\":0,\"active\":0,\"retired\":0,\"nickWith\":[],\"horses\":[]},{\"id\":\"dorobune\",\"lineName\":\"ドロブネ系\",\"founderName\":\"ヌカルミボシ\",\"note\":\"ぬかるんだダートを苦にしない系統。\",\"count\":0,\"active\":0,\"retired\":0,\"nickWith\":[],\"horses\":[]},{\"id\":\"kawarabi\",\"lineName\":\"カワラビ系\",\"founderName\":\"イシコロオー\",\"note\":\"ダートの後方から伸びる系統。\",\"count\":0,\"active\":0,\"retired\":0,\"nickWith\":[],\"horses\":[]}],\"total\":8,\"unlisted\":0,\"rules\":{\"lineFromSire\":true,\"nickBonus\":30,\"inbreedingPenalty\":50,\"generations\":3},\"notice\":\"系統の数で報酬はありません。\"}";

        [Fact]
        public async Task TreeParsesRecordsFoundersAndTheOldFields()
        {
            _http.Reply(200, View);
            var v = await _api.GetPedigreeViewAsync("h3");
            Assert.Equal("/v1/horses/h3/pedigree", _http.Requests[0].Path);
            Assert.False(_http.Requests[0].Headers.ContainsKey("if-none-match"));
            Assert.True(v.IsMine);
            Assert.Equal("akatsuki", v.Line);
            Assert.Equal("アカツキ系", v.LineName);
            Assert.Equal(5, v.Generations);
            Assert.Equal(0, v.InbreedingCount);
            Assert.Equal(50, v.PenaltyPerAncestor);
            Assert.False(string.IsNullOrEmpty(v.Rev));
            var slots = PedigreeTree.Slots(v.Root);
            Assert.Equal("アカツキボーイ", slots[0].Name);
            Assert.Equal("h1", slots[1].Key);
            Assert.Equal("SSR", slots[1].Rec.Rarity);
            Assert.Equal("sk_kireaji", slots[1].Rec.SkillId);
            Assert.Equal("collection/portrait/t_akatsuki", slots[1].Rec.ThumbKey);
            Assert.Equal(820, slots[1].Rec.Stats.Speed);
            Assert.True(slots[1].Rec.HasBest);
            Assert.Equal("出走なし", slots[1].Rec.BestText);
            // the template's fictional sire: name only -> 記録なし, a bloodline founder
            Assert.Null(slots[3].Rec);
            Assert.Equal("記録なし", slots[3].RecordText);
            Assert.True(slots[3].Founder);
            Assert.Equal(3, PedigreeTree.GenOf(slots.Length - 1));
            Assert.Equal("父の母", PedigreeTree.Label(4));
            Assert.Equal("母の母の母", PedigreeTree.Label(14));
            // the old shape still reads (REQ-HORSE-007)
            Assert.True(v.Root.GenerationsAbove >= 2);
        }

        [Fact]
        public async Task ConditionalGetReturnsNullOn304AndOthersHorsesUseThePlayerQuery()
        {
            _http.Reply(304, "").Reply(200, View);
            var same = await _api.GetPedigreeViewAsync("h3", null, "abc123");
            Assert.Null(same);
            Assert.Equal("\"abc123-ja\"", _http.Requests[0].Headers["if-none-match"]);
            var other = await _api.GetPedigreeViewAsync("h3", "player b");
            Assert.Equal("/v1/horses/h3/pedigree?playerId=player%20b", _http.Requests[1].Path);
            Assert.NotNull(other);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.GetPedigreeViewAsync(""));
        }

        [Fact]
        public async Task PairHighlightsSharedAncestorsAndKeepsServerHints()
        {
            _http.Reply(200, Pair);
            var p = await _api.GetBreedingPedigreeAsync("h3", "h4");
            Assert.Equal("/v1/breeding/pedigree?sireId=h3&damId=h4", _http.Requests[0].Path);
            Assert.Equal(p.InbreedingCount, p.SharedKeys.Count);
            Assert.True(p.InbreedingCount > 0);
            Assert.Equal(p.InbreedingCount * p.PenaltyPerAncestor, p.StatPenalty);
            Assert.True(p.IsShared(p.Sire.Sire));
            Assert.True(p.IsShared(p.Dam.Sire));
            Assert.False(p.IsShared(p.Sire));
            Assert.Equal("line", p.Hints[0].Kind);
            Assert.Contains(p.Hints, h => h.Kind == "inbreeding" && h.Value == p.InbreedingCount);
            Assert.All(p.Hints.Where(h => h.Kind == "style"), h => Assert.NotNull(h.Permille));
            Assert.Equal(p.SharedKeys.Count, p.Shared.Count);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.GetBreedingPedigreeAsync("h3", null));
        }

        [Fact]
        public async Task BloodlinesListEveryLineWithNicksAndNoReward()
        {
            _http.Reply(200, Lines);
            var l = await _api.GetBloodlinesAsync();
            Assert.Equal("/v1/bloodlines", _http.Requests[0].Path);
            Assert.Equal(7, l.Lines.Count);
            var ak = l.Line("akatsuki");
            Assert.Equal("アカツキオー", ak.FounderName);
            Assert.True(ak.Count > 0);
            Assert.Contains(ak.NickWith, n => n.Id == "minamo" && n.Role == "dam" && n.Bonus == l.NickBonus);
            Assert.Equal(0, l.Line("kawarabi").Count);
            Assert.Equal("系統の数で報酬はありません。", l.Notice);
            Assert.Equal(50, l.InbreedingPenalty);
        }

        [Fact]
        public void FlowReflowsAtTheLargestTextAndNarrowScreens()
        {
            Assert.Equal(PedigreeTree.Flow.Columns, PedigreeTree.FlowFor(844, 1f));
            Assert.Equal(PedigreeTree.Flow.Rows, PedigreeTree.FlowFor(844, 1.4f));
            Assert.Equal(PedigreeTree.Flow.Rows, PedigreeTree.FlowFor(390, 1f));
            var order = PedigreeTree.Order(PedigreeTree.Flow.Rows);
            Assert.Equal(15, order.Length);
            Assert.Equal(new[] { 0, 1, 2, 3 }, order.Take(4).ToArray());
        }

        [Fact]
        public void PedigreeEventsMatchTheServerSchema()
        {
            var e = AnalyticsEvent.PedigreeView(1, PedigreeSources.Breeding, "self", 20);
            Assert.Equal("pedigree_view", e.Name);
            Assert.Equal("{\"source\":\"breeding\",\"relation\":\"self\",\"shared\":14}", e.PropsJson);
            Assert.Equal("{\"source\":\"pedigree\",\"lines\":7}", AnalyticsEvent.BloodlineView(1, BloodlineSources.Pedigree, 7).PropsJson);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.PedigreeView(1, "home", "self", 0));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.PedigreeView(1, PedigreeSources.Horse, "enemy", 0));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.BloodlineView(1, "shop", 0));
        }
    }
}
