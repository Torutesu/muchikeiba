// Round 10 game-layer checks: 友達招待 (InviteModel, REQ-INV-001..012). The view bodies are the ones the real server code
// produced (engine/Muchi.Engine.Tests/ApiClientInviteTests.cs).
using Muchi.Client;
using Muchi.Game;

static class InviteChecks
{
    const string Inviter = @"{""code"":""92W65BGF"",""displayCode"":""92W6-5BGF"",""share"":{""deepLink"":""muchi://invite/92W65BGF"",""url"":""https://invite.muchi-issen.example/i/92W65BGF"",""text"":""騎手LICEさんから「ムチ一閃」への招待です。招待コード 92W6-5BGF を入力すると、はじめてのプレゼントがもらえます。\nhttps://invite.muchi-issen.example/i/92W65BGF""},""redeem"":{""eligible"":true,""reason"":null,""windowDays"":7,""daysLeft"":7,""invitedBy"":null,""welcomeGift"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""invitees"":[{""playerId"":""bob"",""at"":1793934000000,""counted"":true,""milestones"":[{""id"":""im_graduate"",""at"":1793937600000,""rewarded"":true}],""displayName"":""ボブ""},{""playerId"":""deleted:2"",""at"":1793937600000,""counted"":true,""milestones"":[],""deleted"":true,""displayName"":null},{""playerId"":""zed"",""at"":1793937600000,""counted"":false,""milestones"":[{""id"":""im_graduate"",""at"":1793937600000,""rewarded"":false}],""displayName"":""ゼッド""}],""counted"":2,""cap"":10,""milestones"":[{""id"":""im_graduate"",""kind"":""beginner_complete"",""classId"":null,""target"":null,""reward"":{""freeCoins"":100},""rewardYen"":160},{""id"":""im_class_b"",""kind"":""class"",""classId"":""B"",""target"":null,""reward"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]},""rewardYen"":160}],""termsKey"":""terms.invite""}";
    const string Redeemed = @"{""code"":""6TB4JFMB"",""displayCode"":""6TB4-JFMB"",""share"":{""deepLink"":""muchi://invite/6TB4JFMB"",""url"":""https://invite.muchi-issen.example/i/6TB4JFMB"",""text"":""t""},""redeem"":{""eligible"":false,""reason"":""already_redeemed"",""windowDays"":7,""daysLeft"":7,""invitedBy"":{""playerId"":""alice"",""at"":1793934000000,""milestones"":[],""displayName"":""ハヤテ騎手""},""welcomeGift"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""invitees"":[],""counted"":0,""cap"":10,""milestones"":[],""termsKey"":""terms.invite""}";
    const string Ftue = @"{""code"":""K2NXKVJ2"",""displayCode"":""K2NX-KVJ2"",""share"":{""deepLink"":""d"",""url"":""u"",""text"":""t""},""redeem"":{""eligible"":false,""reason"":""ftue"",""windowDays"":7,""daysLeft"":7,""invitedBy"":null,""welcomeGift"":{}},""invitees"":[],""counted"":0,""cap"":10,""milestones"":[],""termsKey"":""terms.invite""}";

    sealed class FakeApi : IInviteApi
    {
        public string Body = Inviter, After = Redeemed;
        public ApiException Fail;
        public readonly List<(string code, string install)> Redeems = new();
        public readonly List<string> Gets = new();
        public Task<InviteView> GetAsync(string installId, CancellationToken ct) { Gets.Add(installId); return Task.FromResult(InviteView.FromJson(Redeems.Count > 0 && Fail == null ? After : Body)); }
        public Task<InviteRedeemResult> RedeemAsync(string code, string installId, CancellationToken ct)
        {
            Redeems.Add((code, installId));
            if (Fail != null) throw Fail;
            return Task.FromResult(InviteRedeemResult.FromJson(@"{""status"":""redeemed"",""inviter"":{""playerId"":""alice"",""displayName"":""ハヤテ騎手""},""welcomeGift"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]},""friended"":true}"));
        }
    }

    sealed class Sheet : IShareSheet
    {
        public bool Answer = true;
        public string Path = "x", Text;
        public Task<bool> ShareAsync(string filePath, string text, CancellationToken ct) { Path = filePath; Text = text; return Task.FromResult(Answer); }
    }

    public static async Task Run(Action<bool, string> check)
    {
        var kv = new MemoryKeyValueStore();
        var api = new FakeApi();
        var sent = new List<AnalyticsEvent>();
        var m = new InviteModel(api, kv, sent.Add, () => 42);
        string install = m.InstallId;
        check(install.StartsWith("i-") && install == m.InstallId && kv.Get(InviteModel.KeyInstallId) == install, "install id: random, created once, kept in the device store");
        check((await m.LoadAsync()).Ok && api.Gets[0] == install, "load sends the install id (the server refuses this device for my own code)");
        check(m.CodeText == "92W6-5BGF" && m.ShareLabel.EndsWith("»"), "my code in the display form with the share CTA");
        check(m.CapText == "招待ボーナスの対象 2 / 10人", "cap line: counted / cap");
        check(m.TermsKey == "terms.invite", "terms pointer next to the share button");
        check(m.EntryVisible && m.EntryHint == "招待コードを入力すると スカウト券×1 がもらえます（あと7日）", "entry open: welcome gift and days left from the server");
        var ms = m.MilestoneRows;
        check(ms.Count == 2 && ms[0].Title == "初心者ミッションをすべて達成" && ms[0].RewardText == "無償コイン100枚" && ms[1].Title == "B級に昇級" && ms[1].RewardText == "スカウト券×1", "milestone table from the server definitions");
        var rows = m.Rows;
        check(rows.Count == 3 && rows[0].Name == "ボブ" && rows[0].Milestones[0].reached && rows[0].Milestones[0].rewarded && !rows[0].Milestones[1].reached, "invitee row: milestones reached and paid");
        check(rows[1].Deleted && rows[1].Name == "退会したプレイヤー", "a deleted invitee is shown anonymously");
        check(!rows[2].Counted && rows[2].Note.Contains("対象外") && rows[2].Milestones[0].reached && !rows[2].Milestones[0].rewarded, "over the cap: joined, reached, nothing paid, says so");

        // share: the server text verbatim, KPI only when actually shared
        var sheet = new Sheet { Answer = false };
        check(!await m.ShareAsync(sheet) && sent.Count == 0, "cancelled share sends no invite_share");
        sheet.Answer = true;
        check(await m.ShareAsync(sheet) && sheet.Path == null && sheet.Text.Contains("92W6-5BGF") && sheet.Text.Contains("https://invite.muchi-issen.example/i/92W65BGF"), "share sheet gets the server's text with the code and the https link (no file)");
        check(!sheet.Text.Contains("コイン") && !sheet.Text.Contains("円"), "no reward amounts in the share text (03-legal-risk.md)");
        check(sent.Count == 1 && sent[0].Name == "invite_share", "invite_share sent once shared");
        check(m.Copy() == "92W6-5BGF" && m.Copy(link: true) == "https://invite.muchi-issen.example/i/92W65BGF" && sent.Count == 3, "copy code / link (invite_share copy_code / copy_link)");

        // entry: only well-formed codes can be submitted
        m.SetInput("92w6-5bgg");
        check(!m.CanSubmit && m.InputCode == null, "typo (check symbol) keeps the button disabled — no attempt used");
        check(!(await m.RedeemAsync()).Ok && api.Redeems.Count == 0, "…and nothing is sent");
        m.SetInput("92w6 5bgf");
        check(m.CanSubmit && m.InputCode == "92W65BGF", "a well-formed code (lower case, space) enables the button");
        var r = await m.RedeemAsync();
        check(r.Ok && r.Message == "スカウト券×1を受け取りました。ハヤテ騎手さんとフレンドになりました。", "redeem: gift and friend message");
        check(api.Redeems[0] == ("92W65BGF", install), "redeem sends the normalised code and the install id");
        check(!m.EntryVisible && m.EntryHint == "ハヤテ騎手さんの招待で参加しました", "after redeeming the entry closes and names the inviter");

        // errors: neutral sentences, never the anti-abuse reason
        foreach (var (wire, status, text) in new[] { ("INVITE_REFUSED", 409, "この招待コードは使用できません。"), ("NOT_FOUND", 404, "この招待コードは見つかりませんでした。"), ("INVITE_SELF", 409, "自分の招待コードは入力できません。"), ("RATE_LIMITED", 429, "入力が続いたため、しばらくしてからお試しください。") })
        {
            var a2 = new FakeApi { Fail = ApiErrorCodes.Create(wire, "same_device", status) };
            var m2 = new InviteModel(a2, new MemoryKeyValueStore());
            await m2.LoadAsync();
            m2.SetInput("92W65BGF");
            var e = await m2.RedeemAsync();
            check(!e.Ok && e.Message == text && !e.Message.Contains("same_device"), "error " + wire + " → " + text);
        }
        var off = new InviteModel(new FakeApi { Fail = new NetworkException("down", null) }, new MemoryKeyValueStore());
        await off.LoadAsync();
        off.SetInput("92W65BGF");
        check((await off.RedeemAsync()).Message == UxText.Offline, "offline → the offline sentence");

        // FTUE not done: no entry, a hint
        var f = new InviteModel(new FakeApi { Body = Ftue }, new MemoryKeyValueStore());
        await f.LoadAsync();
        check(!f.EntryVisible && f.EntryHint == "チュートリアルを終えると招待コードを入力できます", "before the tutorial is done the entry is hidden");

        // deep links pre-fill, never redeem; the code is remembered across the FTUE
        var kv3 = new MemoryKeyValueStore();
        var a3 = new FakeApi();
        var d = new InviteModel(a3, kv3);
        check(!d.HandleLink("muchi://race/92W65BGF") && !d.HandleLink("https://example.com/x/92W65BGF"), "other links are ignored");
        check(d.HandleLink("muchi://invite/92W65BGF?src=line") && d.Input == "92W6-5BGF" && a3.Redeems.Count == 0, "muchi://invite/<code> pre-fills the entry, does not redeem");
        var d2 = new InviteModel(a3, kv3);
        await d2.LoadAsync();
        check(d2.Input == "92W6-5BGF" && d2.CanSubmit, "a link opened before the FTUE pre-fills the entry once it opens");
        check(new InviteModel(a3, new MemoryKeyValueStore()).HandleLink("https://invite.muchi-issen.example/i/92W65BGF"), "https fallback link works the same");
    }
}
