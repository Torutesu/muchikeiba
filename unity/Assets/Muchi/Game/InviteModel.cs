using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>The invite endpoints the screen uses (ApiInviteApi in the app, a fake in the checks).</summary>
    public interface IInviteApi
    {
        Task<InviteView> GetAsync(string installId, CancellationToken ct);
        Task<InviteRedeemResult> RedeemAsync(string code, string installId, CancellationToken ct);
    }

    public sealed class ApiInviteApi : IInviteApi
    {
        private readonly ApiClient _api;
        public ApiInviteApi(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<InviteView> GetAsync(string installId, CancellationToken ct) => _api.GetInviteAsync(installId, ct);
        public Task<InviteRedeemResult> RedeemAsync(string code, string installId, CancellationToken ct) => _api.RedeemInviteAsync(code, installId, ct);
    }

    /// <summary>One row of 「招待した仲間」.</summary>
    public sealed class InviteeRow
    {
        public string Name;
        /// <summary>Per milestone in table order: reached (and paid) or not yet.</summary>
        public List<(string title, bool reached, bool rewarded)> Milestones = new List<(string, bool, bool)>();
        /// <summary>Over the cap: joined and friends, but milestones pay nothing ("対象外").</summary>
        public bool Counted;
        public bool Deleted;
        public string Note;
    }

    /// <summary>One row of the milestone table (what the inviter gets per invitee).</summary>
    public sealed class InviteMilestoneRow
    {
        public string Id, Title, RewardText;
    }

    /// <summary>
    /// 友達招待 screen (REQ-INV-001..012, contracts/protocol.md §18): my code with the share button, the code entry (only while
    /// the server says it is open: after the tutorial, within the first days), the milestone table and my invitees.
    /// Pure C#: the share sheet is <see cref="IShareSheet"/> (the same one the replay share uses), the install id lives in
    /// <see cref="IKeyValueStore"/> (random, created once per install; only its hash reaches the server).
    /// Rules the screen follows:
    ///  - no reward amounts in the share text (the server's text is used verbatim; 03-legal-risk.md 友達招待);
    ///  - the submit button is enabled only for a well-formed code (check symbol), so typos never use up an attempt;
    ///  - INVITE_REFUSED is shown with a neutral sentence (never why: device, loop …);
    ///  - a deep link (muchi://invite/&lt;code&gt; or https://…/i/&lt;code&gt;) pre-fills the entry; it never redeems by itself.
    /// </summary>
    public sealed class InviteModel
    {
        public const string KeyInstallId = "muchi.installId";
        public const string KeyPendingLinkCode = "muchi.invite.linkCode";

        public static readonly IReadOnlyDictionary<string, string> Errors = new Dictionary<string, string>
        {
            ["INVITE_CODE_INVALID"] = "招待コードが正しくありません。8文字を確かめてください。",
            ["NOT_FOUND"] = "この招待コードは見つかりませんでした。",
            ["INVITE_SELF"] = "自分の招待コードは入力できません。",
            ["INVITE_ALREADY_REDEEMED"] = "招待コードはすでに入力済みです。",
            ["INVITE_WINDOW_CLOSED"] = "招待コードを入力できる期間は終わりました。",
            ["INVITE_REFUSED"] = "この招待コードは使用できません。",
            ["NOT_ELIGIBLE"] = "チュートリアルを終えると入力できます。",
            ["RATE_LIMITED"] = "入力が続いたため、しばらくしてからお試しください。",
        };

        private readonly IInviteApi _api;
        private readonly IKeyValueStore _kv;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;
        private readonly Func<string, string> _itemName;

        public InviteModel(IInviteApi api, IKeyValueStore store, Action<AnalyticsEvent> track = null, Func<long> clock = null, Func<string, string> itemName = null)
        {
            _api = api ?? throw new ArgumentNullException(nameof(api));
            _kv = store ?? new MemoryKeyValueStore();
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _itemName = itemName ?? DefaultItemName;
        }

        public static string DefaultItemName(string id) => id == "gacha_ticket" ? "スカウト券" : id == "gacha_ticket_10" ? "10連スカウト券" : id;

        /// <summary>Random per install (keychain / keystore in the app), created on first use.</summary>
        public string InstallId
        {
            get
            {
                var v = _kv.Get(KeyInstallId);
                if (string.IsNullOrEmpty(v)) { v = "i-" + Guid.NewGuid().ToString("N"); _kv.Set(KeyInstallId, v); }
                return v;
            }
        }

        public InviteView View { get; private set; }
        public bool Loaded => View != null;
        public string Error { get; private set; }

        // ---- my code
        public string CodeText => View?.DisplayCode ?? "----";
        public string ShareLabel => "招待コードを送る »";
        public string CapText => View == null ? "" : "招待ボーナスの対象 " + Math.Min(View.Counted, View.Cap) + " / " + View.Cap + "人";
        public string TermsKey => View?.TermsKey;

        // ---- entry
        /// <summary>The entry section is shown only while the server allows a redemption.</summary>
        public bool EntryVisible => View != null && View.Redeem.Eligible;
        public string EntryHint => View == null ? "" : View.Redeem.Eligible
            ? "招待コードを入力すると " + UxText.Reward(View.Redeem.WelcomeGift, _itemName) + " がもらえます（あと" + View.Redeem.DaysLeft + "日）"
            : View.Redeem.Reason == "already_redeemed" && View.Redeem.InvitedBy != null
                ? (View.Redeem.InvitedBy.DisplayName != null ? View.Redeem.InvitedBy.DisplayName + "さんの招待で参加しました" : "招待で参加しました")
                : View.Redeem.Reason == "ftue" ? "チュートリアルを終えると招待コードを入力できます" : "";
        public string Input { get; private set; } = "";
        /// <summary>Normalised code of the input, or null while it is not a well-formed code.</summary>
        public string InputCode => InviteCodes.Normalize(Input);
        public bool CanSubmit => EntryVisible && InputCode != null && !Busy;
        public bool Busy { get; private set; }

        public List<InviteMilestoneRow> MilestoneRows => View == null ? new List<InviteMilestoneRow>() :
            View.Milestones.Select(d => new InviteMilestoneRow { Id = d.Id, Title = MilestoneTitle(d), RewardText = UxText.Reward(d.Reward, _itemName) }).ToList();

        public List<InviteeRow> Rows
        {
            get
            {
                if (View == null) return new List<InviteeRow>();
                return View.Invitees.Select(x => new InviteeRow
                {
                    Name = x.Deleted ? "退会したプレイヤー" : x.DisplayName ?? "騎手",
                    Counted = x.Counted, Deleted = x.Deleted,
                    Note = x.Counted ? null : "対象外（上限" + View.Cap + "人を超えたため）",
                    Milestones = View.Milestones.Select(d =>
                    {
                        var hit = x.Milestones.FirstOrDefault(y => y.Id == d.Id);
                        return (MilestoneTitle(d), hit != null, hit != null && hit.Rewarded);
                    }).ToList(),
                }).ToList();
            }
        }

        public static string MilestoneTitle(InviteMilestoneDef d)
        {
            switch (d.Kind)
            {
                case "beginner_complete": return "初心者ミッションをすべて達成";
                case "class": return d.ClassId + "級に昇級";
                case "ranked_races": return "ランク戦" + (d.Target ?? 0) + "戦";
                default: return d.Id;
            }
        }

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            try
            {
                View = await _api.GetAsync(InstallId, ct);
                Error = null;
                var pending = _kv.Get(KeyPendingLinkCode);
                if (!string.IsNullOrEmpty(pending) && EntryVisible && Input.Length == 0) Input = InviteCodes.Display(pending);
                return ActionResult.Success();
            }
            catch (ApiException e)
            {
                Error = UxText.For(e);
                return ActionResult.Error(Error);
            }
        }

        public void SetInput(string raw) { Input = raw ?? ""; }

        /// <summary>An opened link (deep link or https fallback). Remembers the code and pre-fills the entry; never redeems.</summary>
        public bool HandleLink(string url, string scheme = "muchi")
        {
            var code = InviteCodes.FromLink(url, scheme);
            if (code == null) return false;
            _kv.Set(KeyPendingLinkCode, code);
            if (View == null || EntryVisible) Input = InviteCodes.Display(code);
            return true;
        }

        public async Task<ActionResult> RedeemAsync(CancellationToken ct = default)
        {
            if (!CanSubmit) return ActionResult.Error(InputCode == null ? Errors["INVITE_CODE_INVALID"] : "");
            Busy = true;
            try
            {
                var r = await _api.RedeemAsync(InputCode, InstallId, ct);
                _kv.Set(KeyPendingLinkCode, "");
                await LoadAsync(ct);
                string who = r.InviterName ?? "招待してくれた人";
                string msg = UxText.Reward(r.WelcomeGift, _itemName) + "を受け取りました。" + (r.Friended ? who + "さんとフレンドになりました。" : "");
                return ActionResult.Success(msg);
            }
            catch (ApiException e)
            {
                Error = e is NetworkException ? UxText.Offline : Errors.TryGetValue(e.WireCode ?? "", out var t) ? t : UxText.For(e);
                return ActionResult.Error(Error);
            }
            finally { Busy = false; }
        }

        /// <summary>Hands the server's share text (code + https link) to the OS share sheet; invite_share is sent only when shared.</summary>
        public async Task<bool> ShareAsync(IShareSheet sheet, CancellationToken ct = default)
        {
            if (View == null || sheet == null) return false;
            bool shared = await sheet.ShareAsync(null, View.Share.Text, ct);
            if (shared) _track?.Invoke(AnalyticsEvent.InviteShare(_clock(), "os_share"));
            return shared;
        }

        /// <summary>The text to put on the clipboard (code only, or the link); sends invite_share with the channel.</summary>
        public string Copy(bool link = false)
        {
            if (View == null) return null;
            _track?.Invoke(AnalyticsEvent.InviteShare(_clock(), link ? "copy_link" : "copy_code"));
            return link ? View.Share.Url : View.DisplayCode;
        }
    }
}
