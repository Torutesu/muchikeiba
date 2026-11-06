using System;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>Scout screens against the server (online only; paid scouting does not exist offline).</summary>
    public sealed class GachaBackend
    {
        private readonly GameBackend _b;
        private readonly Func<long> _deviceNow;
        public GachaBackend(GameBackend backend, Func<long> deviceNowMs = null)
        {
            _b = backend ?? throw new ArgumentNullException(nameof(backend));
            _deviceNow = deviceNowMs ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public const string OfflineNotice = "OFFLINE  /  スカウトはオンラインのみ";

        /// <summary>Banner calendar with the player's pity meter applied.</summary>
        public async Task<BannerListModel> BannersAsync(CancellationToken ct = default)
        {
            if (!_b.Online) return BannerListModel.Offline(OfflineNotice);
            try
            {
                var m = new BannerListModel(await _b.Api.GetBannerScheduleAsync(ct), _deviceNow());
                try { m.ApplyStatus(await _b.Api.GetGachaStatusAsync(ct)); } catch (ApiException) { /* list without the meter */ }
                return m;
            }
            catch (ApiException e) { return BannerListModel.Offline(e.WireCode + "  /  " + e.Message); }
        }

        /// <summary>One scout; the reveal model on success, or the message (BANNER_CLOSED → reload the list).</summary>
        public async Task<(GachaRevealModel reveal, ApiErrorCode? error, string message)> DrawAsync(string bannerId, int count, Func<string, string> nameOf = null, CancellationToken ct = default)
        {
            if (!_b.Online) return (null, null, OfflineNotice);
            try
            {
                var r = await _b.Api.DrawAsync(bannerId, count, null, ct);
                await _b.RefreshAsync(ct);
                return (new GachaRevealModel(r, nameOf), null, null);
            }
            catch (ApiException e) { return (null, e.Code, BannerListModel.ErrorText(e.Code)); }
        }
    }
}
