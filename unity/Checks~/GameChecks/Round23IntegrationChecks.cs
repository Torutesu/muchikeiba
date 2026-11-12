// Round 23 integration (contracts/protocol.md §70.6 × §54.6 × §46, §71.7): ONE AccountChangeReset drops both the cached
// device list (§70) and the cached pedigree trees (§71) when 401 SESSION_REVOKED (or SESSION_REPLACED) appears, and the
// screen priority: SESSION_REPLACED > SESSION_REVOKED > update required > maintenance > offline, in either order of arrival.
using Muchi.Client;
using Muchi.Game;
using Muchi.Net;

static class Round23IntegrationChecks
{
    sealed class Devices : IDeviceSessionsApi
    {
        static DeviceSessionList List() => new DeviceSessionList
        {
            Enabled = true, Current = "s_a", TrustAfterHours = 24, RevokesPerDay = 10, SignOutOthers = new SignOutOthersInfo { Allowed = true, Count = 1 },
            Sessions = { new DeviceSession { SessionId = "s_a", Current = true, Platform = "ios" }, new DeviceSession { SessionId = "s_b", Platform = "android", CanSignOut = true } },
        };
        public Task<DeviceSessionList> CheckinDeviceAsync(DeviceCheckin device, string installId = null, CancellationToken ct = default) => Task.FromResult(List());
        public Task<DeviceSessionList> GetDevicesAsync(CancellationToken ct = default) => Task.FromResult(List());
        public Task<DeviceSignOutResult> SignOutDeviceAsync(string sessionId, CancellationToken ct = default) => Task.FromResult(new DeviceSignOutResult { SignedOut = 1, Devices = List() });
        public Task<DeviceSignOutResult> SignOutOtherDevicesAsync(CancellationToken ct = default) => Task.FromResult(new DeviceSignOutResult { SignedOut = 1, Devices = List() });
        public Task<SecurityLog> GetSecurityLogAsync(CancellationToken ct = default) => Task.FromResult(new SecurityLog { Enabled = true, LogDays = 180 });
    }

    sealed class Pedigrees : IPedigreeApi
    {
        public Task<PedigreeView> GetPedigreeViewAsync(string horseId, string playerId = null, string knownRev = null, CancellationToken ct = default) =>
            Task.FromResult(new PedigreeView { Root = new PedigreeNode { Key = horseId, Name = "ホシカゲ", HorseId = horseId }, Relation = "self", Rev = "r1", Generations = 5 });
        public Task<BreedingPedigree> GetBreedingPedigreeAsync(string sireId, string damId, CancellationToken ct = default) =>
            Task.FromResult(new BreedingPedigree { Sire = new PedigreeNode { Key = sireId, Name = "A" }, Dam = new PedigreeNode { Key = damId, Name = "B" } });
        public Task<BloodlineList> GetBloodlinesAsync(CancellationToken ct = default) => Task.FromResult(new BloodlineList { NickBonus = 30, InbreedingPenalty = 50, Generations = 3 });
    }

    public static async Task Run(Action<bool, string> check)
    {
        async Task<(DeviceSessionsModel dev, PedigreeModel ped, AccountChangeReset reset, MaintenanceModel maint)> Fresh()
        {
            var dev = new DeviceSessionsModel(new Devices(), () => true, () => 1794380400000, null);
            await dev.LoadAsync();
            var ped = new PedigreeModel(new Pedigrees(), null, () => 1000);
            await ped.OpenAsync("h3", PedigreeSources.Horse);
            var maint = new MaintenanceModel(null, "ios");
            var reset = new AccountChangeReset { Devices = dev, Pedigree = ped };
            reset.Watch(maint);
            return (dev, ped, reset, maint);
        }

        // SESSION_REVOKED: one reset drops both per-account caches
        var w = await Fresh();
        check(w.dev.List != null && w.ped.CachedTrees == 1, "r23: the device list and a pedigree tree are cached for this account");
        w.maint.OnSessionRevoked();
        w.maint.OnSessionRevoked();
        check(w.reset.Resets == 1 && w.dev.List == null && w.ped.CachedTrees == 0 && w.ped.View == null, "r23: SESSION_REVOKED → one AccountChangeReset forgets the device list and the pedigree trees");

        // SESSION_REPLACED does the same (the transfer path)
        w = await Fresh();
        w.maint.OnSessionReplaced();
        check(w.reset.Resets == 1 && w.dev.List == null && w.ped.CachedTrees == 0, "r23: SESSION_REPLACED also forgets both caches");

        // priority: revoked first, then update / maintenance / offline never replace it
        w = await Fresh();
        w.maint.OnSessionRevoked();
        w.maint.OnUpgrade(new UpgradeInfo { Reason = "version" });
        check(w.maint.Screen == MaintenanceScreen.SessionRevoked, "r23: a forced update after SESSION_REVOKED keeps the signed-out screen");
        w.maint.OnMaintenance(new MaintenanceInfo { WindowId = "m1", Group = "gacha", Scope = { "all" } });
        w.maint.OnOffline();
        check(w.maint.Screen == MaintenanceScreen.SessionRevoked, "r23: maintenance and offline never replace the signed-out screen");
        w.maint.OnSessionReplaced();
        check(w.maint.Screen == MaintenanceScreen.SessionReplaced, "r23: SESSION_REPLACED wins over SESSION_REVOKED");
        w.maint.OnSessionRevoked();
        check(w.maint.Screen == MaintenanceScreen.SessionReplaced && w.reset.Resets == 2, "r23: a later SESSION_REVOKED never replaces SESSION_REPLACED");

        // priority: update / maintenance first, then SESSION_REVOKED takes over (the account is gone whatever the app version)
        w = await Fresh();
        w.maint.OnUpgrade(new UpgradeInfo { Reason = "version" });
        check(w.maint.Screen == MaintenanceScreen.UpdateRequired, "r23: the update screen first");
        w.maint.OnSessionRevoked();
        check(w.maint.Screen == MaintenanceScreen.SessionRevoked && w.reset.Resets == 1, "r23: SESSION_REVOKED replaces the update screen and resets the account state");
        w = await Fresh();
        w.maint.OnMaintenance(new MaintenanceInfo { WindowId = "m2", Group = "core", Scope = { "all" } });
        w.maint.OnSessionRevoked();
        check(w.maint.Screen == MaintenanceScreen.SessionRevoked && w.maint.Info == null, "r23: SESSION_REVOKED replaces the maintenance screen");
        w.maint.LeaveSessionRevoked();
        check(w.maint.Screen == MaintenanceScreen.None, "r23: signing in again / starting new leaves the signed-out screen");
    }
}
