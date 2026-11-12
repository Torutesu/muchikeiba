// 血統図と系統 (REQ-PED-001..020, contracts/protocol.md §71): PedigreeModel over a fake API. The tree in 15 fixed slots with
// relation labels, shared ancestors from the server (the inbreeding line quotes the server's numbers), 記録なし and the
// borrowed-stallion owner line, the session cache revalidated by rev (304 keeps it, offline shows it), a hidden horse, the
// breeding pair's shared line, the bloodline list (no completion state), AccountChangeReset and the KPI rows.
using Muchi.Client;
using Muchi.Game;

static class PedigreeChecks
{
    sealed class FakeApi : IPedigreeApi
    {
        public readonly List<string> Calls = new List<string>();
        public bool Down, Hidden;
        public Task<PedigreeView> GetPedigreeViewAsync(string horseId, string playerId = null, string knownRev = null, CancellationToken ct = default)
        {
            Calls.Add("GET " + horseId + (playerId != null ? "@" + playerId : "") + (knownRev != null ? " rev=" + knownRev : ""));
            if (Down) throw new NetworkException("offline", null);
            if (Hidden) throw new NotFoundException(ApiErrorCode.NotFound, "NOT_FOUND", "this horse is not shown", 404);
            if (knownRev == "r1") return Task.FromResult<PedigreeView>(null); // 304
            return Task.FromResult(Tree(playerId == null ? "self" : "other"));
        }
        public Task<BreedingPedigree> GetBreedingPedigreeAsync(string sireId, string damId, CancellationToken ct = default)
        {
            Calls.Add("PAIR " + sireId + "x" + damId);
            var gp = new PedigreeNode { Key = "h1", Name = "シンセイアカツキ", Shared = true, Rec = new PedigreeRecord { Style = "sashi" } };
            return Task.FromResult(new BreedingPedigree
            {
                Sire = new PedigreeNode { Key = sireId, Name = "アカツキボーイ", Sire = gp }, Dam = new PedigreeNode { Key = damId, Name = "ハナコ", Sire = gp },
                SharedKeys = new List<string> { "h1", "name:アカツキオー" }, Shared = new List<KeyValuePair<string, string>> { new("h1", "シンセイアカツキ"), new("name:アカツキオー", "アカツキオー") },
                InbreedingCount = 2, PenaltyPerAncestor = 50, StatPenalty = 100,
                Hints = new List<PedigreeHint> { new PedigreeHint { Kind = "line", Text = "仔の系統は父と同じ「アカツキ系」" } },
            });
        }
        public Task<BloodlineList> GetBloodlinesAsync(CancellationToken ct = default)
        {
            Calls.Add("LINES");
            var l = new BloodlineList { NickBonus = 30, InbreedingPenalty = 50, Generations = 3, Notice = "系統の数で報酬はありません。" };
            l.Lines.Add(new Bloodline { Id = "akatsuki", LineName = "アカツキ系", FounderName = "アカツキオー", Count = 4, Active = 2, Retired = 2, NickWith = new List<BloodlineNick> { new BloodlineNick { Id = "minamo", LineName = "ミナモ系", Role = "dam", Bonus = 30 } } });
            l.Lines.Add(new Bloodline { Id = "kawarabi", LineName = "カワラビ系", FounderName = "イシコロオー" });
            return Task.FromResult(l);
        }

        static PedigreeView Tree(string relation)
        {
            var stud = new PedigreeNode { Key = "stud:1", Name = "ギンガノカナタ", IsLent = true, LentLabel = "他のトレーナーの馬", Rec = new PedigreeRecord { Style = "senko", GoingAptitude = "heavy", SkillName = "王道" },
                Sire = new PedigreeNode { Key = "name:ホシノオウ", Name = "ホシノオウ", RecordText = "記録なし", Founder = true } };
            var dam = new PedigreeNode { Key = "h2", Name = "コハクノヒカリ", HorseId = relation == "self" ? "h2" : null, Shared = true, Rec = new PedigreeRecord { Style = "nige", GoingAptitude = "any" } };
            var root = new PedigreeNode { Key = "h3", Name = "ホシカゲ", HorseId = "h3", Sire = stud, Dam = dam, Rec = new PedigreeRecord { Style = "senko" } };
            return new PedigreeView { Root = root, Relation = relation, Rev = "r1", Generations = relation == "self" ? 5 : 3, InbreedingCount = 1, PenaltyPerAncestor = 50, StatPenalty = 50, SharedKeys = new List<string> { "h2" } };
        }
    }

    public static async Task Run(Action<bool, string> check, string root)
    {
        var api = new FakeApi();
        var rows = new List<AnalyticsEvent>();
        var m = new PedigreeModel(api, rows.Add, () => 1000);
        check(await m.OpenAsync("h3", PedigreeSources.Horse) && m.Boxes.Count == 15, "the tree opens in 15 fixed slots");
        check(m.Boxes[1].Relation == "父" && m.Boxes[4].Relation == "父の母" && m.Boxes[14].Relation == "母の母の母", "every slot has its relation label");
        check(m.Boxes[1].OwnerLine == "他のトレーナーの馬" && m.Boxes[3].NoRecord && m.Boxes[3].TraitLine == "記録なし" && m.Boxes[3].Node.Founder, "a stranger's stallion, 記録なし and the founder mark come from the server");
        check(m.Boxes[1].TraitLine == "先行・重馬場が得意・王道", "the trait line: style, ground, unique skill");
        check(m.Boxes[2].Shared && !m.Boxes[1].Shared && m.Boxes[5].Empty, "shared ancestors are highlighted; unknown slots are empty");
        check(m.InbreedingLine == "近親：共通の祖先1頭（能力の基準 −50）", "the inbreeding line quotes the server's count and penalty");
        check(m.CanOpenAncestor(m.Boxes[2]) && !m.CanOpenAncestor(m.Boxes[0]) && !m.CanOpenAncestor(m.Boxes[3]), "only my own ancestors open their own tree");
        check(rows.Count == 1 && rows[0].Name == "pedigree_view" && rows[0].PropsJson == "{\"source\":\"horse\",\"relation\":\"self\",\"shared\":1}", "pedigree_view once per opened tree (no ids)");
        // revalidation: the held rev is sent; 304 keeps the copy
        check(await m.OpenAsync("h3", PedigreeSources.Horse) && api.Calls[^1] == "GET h3 rev=r1" && m.Revalidated == 1 && m.View.Root.Name == "ホシカゲ", "a second open revalidates with the rev and keeps the copy on 304");
        api.Down = true;
        check(await m.OpenAsync("h3", PedigreeSources.Horse) && m.View != null, "offline: the session copy still shows");
        check(!await m.OpenAsync("h9", PedigreeSources.Horse) && m.Message == PedigreeModel.OfflineText, "offline without a copy: the offline line");
        api.Down = false;
        api.Hidden = true;
        check(!await m.OpenAsync("h7", PedigreeSources.Stable, "b") && m.Message == PedigreeModel.HiddenText && m.Boxes.Count == 0, "another player's hidden horse: one neutral line, nothing drawn");
        api.Hidden = false;
        check(await m.OpenAsync("h7", PedigreeSources.Showcase, "b") && !m.View.IsMine && !m.CanOpenAncestor(m.Boxes[2]), "another player's tree never opens deeper");
        // the pair
        check(await m.OpenPairAsync("h3", "h4") && m.PairSharedLine == "共通の祖先 シンセイアカツキ・アカツキオー（能力の基準 −100）", "the pair's shared line uses the server's names and penalty");
        check(rows[^1].PropsJson == "{\"source\":\"breeding\",\"relation\":\"self\",\"shared\":2}", "the pair sends pedigree_view from breeding");
        // bloodlines
        check(await m.OpenBloodlinesAsync(BloodlineSources.Pedigree) && m.Bloodlines.Lines.Count == 2 && PedigreeModel.CountText(m.Bloodlines.Line("akatsuki")) == "4頭（現役2・引退2）", "bloodline counts per line");
        check(PedigreeModel.NickLines(m.Bloodlines.Line("akatsuki"))[0] == "ニックス：ミナモ系（母）+30" && m.Bloodlines.Line("kawarabi").Count == 0, "nick partners and empty lines");
        check(rows[^1].Name == "bloodline_view" && rows[^1].PropsJson == "{\"source\":\"pedigree\",\"lines\":2}", "bloodline_view once per opened list");
        // account change
        var reset = new AccountChangeReset { Pedigree = m };
        check(m.CachedTrees > 0, "trees are cached for the session");
        reset.OnAccountChanged();
        check(m.CachedTrees == 0 && m.View == null && m.Bloodlines == null, "AccountChangeReset forgets the cached trees");
        await Task.CompletedTask;
    }
}
