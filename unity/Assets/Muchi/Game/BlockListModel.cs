using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>One blocked player as the list draws it (the name is the player's own: never translated).</summary>
    public sealed class BlockRow
    {
        public string PlayerId, Name;
        public bool Busy;
    }

    /// <summary>One line of 「ブロックするとどうなる？」 (text from the server; icon key Codex maps to a sprite).</summary>
    public sealed class BlockEffectRow
    {
        public string Feature, Text, Icon;
    }

    /// <summary>
    /// 通報とブロック — the block management screen (REQ-RPT-010..012, contracts/protocol.md §47.1–47.3). Rules:
    ///  - the list is the server's one block list (the team feed's mute list): newest first, current names;
    ///  - unblocking asks first (<see cref="AskUnblock"/> → <see cref="ConfirmUnblockAsync"/>), never on one tap; the other
    ///    player is not told either way;
    ///  - one change per row at a time; a failed change leaves the row as it was with <see cref="Message"/>;
    ///  - <see cref="Effects"/> explains what a block does in each feature (activity, team feed, rival, stable, hall, replays, cups);
    ///  - offline: no list, <see cref="OfflineText"/> (blocking and unblocking need the server).
    /// </summary>
    public sealed class BlockListModel
    {
        public const string Title = "通報とブロック";
        public const string ListLabel = "ブロック中";
        public const string EffectsLabel = "ブロックするとどうなる？";
        public const string EmptyText = "ブロックしている人はいません";
        public const string OfflineText = "ブロックの一覧はオンラインで確認できます";
        public const string UnblockCta = "ブロック解除";
        public const string ConfirmTitle = "ブロックを解除しますか？";
        public const string ConfirmBody = "解除すると、この人のお知らせ・マイ厩舎・殿堂・リプレイがまた見えるようになります。相手には知らされません。";
        public const string ConfirmCta = "解除する";
        public const string CancelCta = "やめる";
        public const string UnblockedText = "ブロックを解除しました";
        public const string BlockedText = "ブロックしました";
        public const string FullText = "ブロックできる人数の上限です。誰かの解除が必要です";
        public const string GuidelinesNote = "名前・キャプション・ふるまいが気になったら、その人のプロフィールやリプレイの「通報する」から運営に知らせてください。";
        public static readonly IReadOnlyDictionary<string, string> Icons = new Dictionary<string, string>
        {
            ["activity"] = "bell", ["team_feed"] = "stamp", ["rival"] = "rival", ["stable"] = "stable", ["hall"] = "trophy", ["replays"] = "replay", ["cups"] = "cup", ["links"] = "link", // §63: shared links and rematch rooms
        };

        private readonly IReportApi _api;
        private readonly Func<bool> _online;

        public BlockListModel(IReportApi api, Func<bool> online = null)
        {
            _api = api;
            _online = online ?? (() => true);
        }

        public List<BlockRow> Rows { get; } = new List<BlockRow>();
        public List<BlockEffectRow> Effects { get; } = new List<BlockEffectRow>();
        public int Count { get; private set; }
        public int Max { get; private set; }
        /// <summary>"3/100" next to the list label.</summary>
        public string CountText => Count + "/" + Max;
        public bool Loading { get; private set; }
        public string Message { get; private set; }
        /// <summary>The row waiting for 「解除する」 (null = no dialog).</summary>
        public BlockRow Confirming { get; private set; }

        public bool IsBlocked(string playerId) => Rows.Any(r => r.PlayerId == playerId);

        public async Task OpenAsync(CancellationToken ct = default)
        {
            Rows.Clear(); Effects.Clear(); Message = null; Confirming = null;
            if (!_online() || _api == null) { Message = OfflineText; return; }
            Loading = true;
            try
            {
                var l = await _api.GetBlocksAsync(ct);
                Rows.AddRange(l.Blocked.Select(b => new BlockRow { PlayerId = b.PlayerId, Name = b.Name }));
                Effects.AddRange(l.Effects.Select(e => new BlockEffectRow { Feature = e.Feature, Text = e.Text, Icon = Icons.TryGetValue(e.Feature ?? "", out var i) ? i : "info" }));
                Count = l.Count; Max = l.Max;
                if (Rows.Count == 0) Message = EmptyText;
            }
            catch (ApiException e) { Message = UxText.For(e); }
            finally { Loading = false; }
        }

        /// <summary>Tap on 「解除」: opens the confirmation (nothing is sent yet).</summary>
        public void AskUnblock(BlockRow row) { if (row != null && !row.Busy) Confirming = row; }
        public void CancelUnblock() => Confirming = null;

        /// <summary>「解除する」 in the dialog: unblocks the confirming row (idempotent on the server).</summary>
        public async Task<bool> ConfirmUnblockAsync(CancellationToken ct = default)
        {
            var row = Confirming;
            Confirming = null;
            if (row == null || row.Busy) return false;
            if (!_online() || _api == null) { Message = OfflineText; return false; }
            row.Busy = true;
            try
            {
                var r = await _api.UnblockAsync(row.PlayerId, ct);
                Rows.Remove(row);
                Count = r.Count; Max = r.Max;
                Message = Rows.Count == 0 ? EmptyText : UnblockedText;
                return true;
            }
            catch (ApiException e) { Message = UxText.For(e); return false; }
            finally { row.Busy = false; }
        }

        /// <summary>Block from a profile / list (the row appears at the top). TEAM_LIMIT = the list is full.</summary>
        public async Task<bool> BlockAsync(string playerId, string name, CancellationToken ct = default)
        {
            if (!_online() || _api == null) { Message = OfflineText; return false; }
            try
            {
                var r = await _api.BlockAsync(playerId, ct);
                if (!IsBlocked(playerId)) Rows.Insert(0, new BlockRow { PlayerId = playerId, Name = name });
                Count = r.Count; Max = r.Max;
                Message = BlockedText;
                return true;
            }
            catch (ApiException e) { Message = e.WireCode == "TEAM_LIMIT" ? FullText : UxText.For(e); return false; }
        }
    }
}
