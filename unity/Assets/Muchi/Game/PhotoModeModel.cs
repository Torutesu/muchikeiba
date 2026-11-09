using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    // REQ-PHOTO-001..018 (contracts/protocol.md §38, docs/handoff-codex-round15-photo-mode.md): フォトモード, the game layer.
    // Pure C#: Codex's screen binds to the public members, poses the scene with PosedPhoto and renders through the replay
    // share recorder (IClipRecorder.CaptureStillAsync) + IShareSheet. Nothing here changes a race: a paused race is only
    // paused / resumed, the picture comes from a re-simulated copy (PhotoSnapshot).

    /// <summary>The server calls photo mode needs (ApiClient in the app, a fake in the checks).</summary>
    public interface IPhotoApi
    {
        Task<PhotoCatalog> GetPhotoCatalogAsync(CancellationToken ct = default);
        Task<PhotoList> GetPhotosAsync(CancellationToken ct = default);
        Task<PhotoList> SavePhotoAsync(PhotoSpec spec, string idempotencyKey = null, CancellationToken ct = default);
        Task<PhotoList> DeletePhotoAsync(string photoId, CancellationToken ct = default);
        Task<CosmeticPurchase> BuyCosmeticAsync(string itemId, string idempotencyKey = null, CancellationToken ct = default);
    }

    /// <summary><see cref="IPhotoApi"/> over the real client.</summary>
    public sealed class ApiPhoto : IPhotoApi
    {
        private readonly ApiClient _api;
        public ApiPhoto(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<PhotoCatalog> GetPhotoCatalogAsync(CancellationToken ct = default) => _api.GetPhotoCatalogAsync(ct);
        public Task<PhotoList> GetPhotosAsync(CancellationToken ct = default) => _api.GetPhotosAsync(ct);
        public Task<PhotoList> SavePhotoAsync(PhotoSpec spec, string idempotencyKey = null, CancellationToken ct = default) => _api.SavePhotoAsync(spec, idempotencyKey, ct);
        public Task<PhotoList> DeletePhotoAsync(string photoId, CancellationToken ct = default) => _api.DeletePhotoAsync(photoId, ct);
        public Task<CosmeticPurchase> BuyCosmeticAsync(string itemId, string idempotencyKey = null, CancellationToken ct = default) => _api.BuyCosmeticAsync(itemId, idempotencyKey, ct);
    }

    /// <summary>World placement of the photo (same transform as the live race and the replay share).</summary>
    public sealed class PosedPhoto
    {
        public ReplayClipFrame Frame;
        /// <summary>Per slot (index = slot).</summary>
        public WorldPose[] Horses;
        public WorldCameraShot Camera;
        /// <summary>0 = off .. 3 = strong (the post-process depth of field around the focus horse).</summary>
        public int Dof;
        public string LookAsset;
    }

    /// <summary>Why an item cannot be used yet, and whether the shop sells it.</summary>
    public sealed class PhotoLock
    {
        public PhotoItem Item;
        public string Text;
        public bool Buyable;
    }

    public enum PhotoOutcomeKind { Shared, Cancelled, Failed }

    /// <summary>
    /// フォトモード. Rules the model keeps:
    ///  - a running race opens it only when <see cref="CanPause"/> (a solo race the device runs; never ranked / friend /
    ///    event / tournament, which are photographed from the result screen or the replay);
    ///  - the race is paused while the screen is open and resumed by <see cref="Close"/>; the picture comes from
    ///    PhotoSnapshot (a re-simulated copy), so the race state and its hash never change;
    ///  - the camera is always clamped to the catalog's limits and kept above the course;
    ///  - only unlocked looks / frames / stamps are applied (a locked one returns its PhotoLock: the unlock text, or a
    ///    purchase through the cosmetics shop at its fixed price);
    ///  - name plates: you / friends' names / p&lt;slot&gt; / CPU, or none (<see cref="ToggleNames"/>);
    ///  - photo_take on every shutter, photo_share only when the share sheet reports a share; saving needs the network
    ///    (offline the photo can still be taken and shared with the free items).
    /// </summary>
    public sealed class PhotoModeModel
    {
        public const string Title = "フォトモード";
        public const string OfflineSaveText = "写真の保存はオンラインでできます。共有はこのままできます";
        public const string SavedText = "写真を保存しました";
        public const string FullText = "保存できる写真がいっぱいです。古い写真を消してから保存してください。";
        public const string FailedText = "写真を作れませんでした。もう一度お試しください";
        /// <summary>The lock badge on a locked item (the reason is PhotoLock.Text, the server's unlock text).</summary>
        public const string LockedLabel = "未解放";
        public const string HideUiLabel = "UIを隠す";
        public const string NamesShownLabel = "名前を表示";
        public const string NamesHiddenLabel = "名前を隠す";

        private readonly IPhotoApi _api;
        private readonly Func<bool> _online;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;
        private OfflineRace _paused;
        private string _saveKey;
        private readonly IReadOnlyDictionary<string, string> _friends;
        private readonly RaceVisuals _visuals;
        private readonly string _courseName;

        public PhotoCatalog Catalog { get; private set; } = PhotoCatalog.Offline();
        public PhotoSnapshot Snapshot { get; }
        public PhotoSpec Spec { get; }
        public int PlayerSlot { get; }
        public bool HideUi { get; private set; }
        public string CaptionProblem { get; private set; }
        public string Message { get; private set; }
        public bool Busy { get; private set; }
        public bool Open => !_closed;
        private bool _closed;

        private PhotoModeModel(IPhotoApi api, PhotoSnapshot snap, PhotoSource source, int playerSlot, RaceVisuals visuals, string courseName,
            IReadOnlyDictionary<string, string> friends, Func<bool> online, Action<AnalyticsEvent> track, Func<long> clock)
        {
            _api = api;
            _online = online ?? (() => true);
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _friends = friends;
            _visuals = visuals;
            _courseName = courseName;
            Snapshot = snap;
            PlayerSlot = playerSlot;
            int focus = playerSlot >= 0 && playerSlot < snap.States.Length ? playerSlot : 0;
            Spec = new PhotoSpec { Source = source, Camera = PhotoCamera.Clamp(new PhotoCameraParams { FocusSlot = focus }, Catalog.Camera, snap.States.Length) };
        }

        // ------------------------------------------------------------------------------------------- entry points

        /// <summary>REQ-PHOTO-001: may the pause menu offer 「フォト」 for this running race?</summary>
        public static bool CanPause(IRaceDriver driver)
        {
            if (!(driver is OfflineRaceDriver o) || o.Config == null || o.Done || o.Phase != RacePhase.Racing) return false;
            return !PhotoSource.IsShared(PhotoSource.ModeOf(o.Config.Mode, online: false));
        }

        /// <summary>The result screen can open photo mode for any finished race the device can replay (any mode).</summary>
        public static bool CanOpenFromResult(IRaceDriver driver) => ReplayShareModel.CanShare(driver);

        /// <summary>Pause a solo race and open photo mode at its current tick (<see cref="Close"/> resumes it).</summary>
        public static PhotoModeModel OpenPaused(OfflineRaceDriver driver, IPhotoApi api, string raceId = null, string courseName = null,
            IReadOnlyDictionary<string, string> friends = null, Func<bool> online = null, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            if (!CanPause(driver)) return null;
            var now = (clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))();
            driver.Race.Pause(now);
            var snap = PhotoSnapshot.Capture(driver.Race);
            var src = new PhotoSource { Kind = PhotoSourceKinds.Paused, Mode = PhotoSource.ModeOf(driver.Config.Mode, false), RaceId = raceId ?? LocalRaceId(driver.Config), Tick = snap.Tick };
            return new PhotoModeModel(api, snap, src, driver.PlayerSlot, driver.Visuals, courseName, friends, online, track, clock) { _paused = driver.Race };
        }

        /// <summary>Open from the result screen: the finished race at the moment the player's horse crossed the line.</summary>
        public static PhotoModeModel OpenFromResult(IRaceDriver driver, IPhotoApi api, string raceId = null, string courseName = null,
            IReadOnlyDictionary<string, string> friends = null, Func<bool> online = null, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            if (!CanOpenFromResult(driver)) return null;
            var inputs = ReplayShareModel.InputsOf(driver);
            var me = driver.Sim.GetHorse(driver.PlayerSlot);
            int tick = me.Finished ? me.FinishTick + 1 : driver.Sim.Tick;
            var snap = PhotoSnapshot.Capture(driver.Config, inputs, tick);
            var src = new PhotoSource { Kind = PhotoSourceKinds.Result, Mode = PhotoSource.ModeOf(driver.Config.Mode, driver.Online), RaceId = raceId ?? driver.Config.RaceId ?? LocalRaceId(driver.Config), Tick = snap.Tick };
            return new PhotoModeModel(api, snap, src, driver.PlayerSlot, driver.Visuals, courseName, friends, online, track, clock);
        }

        /// <summary>Open from the replay player at <paramref name="tick"/> (a replay share clip, or a saved replay's config + inputs).</summary>
        public static PhotoModeModel OpenFromReplay(RaceConfig config, IList<InputRecord> inputs, int tick, int playerSlot, string mode, string raceId, IPhotoApi api,
            RaceVisuals visuals = null, string courseName = null, IReadOnlyDictionary<string, string> friends = null, Func<bool> online = null, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            var snap = PhotoSnapshot.Capture(config, inputs, tick);
            var src = new PhotoSource { Kind = PhotoSourceKinds.Replay, Mode = mode, RaceId = raceId ?? config.RaceId ?? LocalRaceId(config), Tick = snap.Tick };
            return new PhotoModeModel(api, snap, src, playerSlot, visuals, courseName, friends, online, track, clock);
        }

        /// <summary>A local id for a race without a server id ("local:&lt;seed&gt;"): enough to find it again on this device.</summary>
        public static string LocalRaceId(RaceConfig cfg) => "local:" + (cfg.RaceId ?? "race") .Replace(' ', '_') + "_" + cfg.Seed;

        /// <summary>Leave photo mode. A paused race resumes where it stopped (its timeline does not count the pause).</summary>
        public void Close()
        {
            if (_closed) return;
            _closed = true;
            _paused?.Resume(_clock());
            _paused = null;
        }

        // ------------------------------------------------------------------------------------------- catalog

        /// <summary>The server catalog (online), else the free items of the shipped catalog. Keeps the camera inside the new limits.</summary>
        public async Task LoadCatalogAsync(CancellationToken ct = default)
        {
            if (_online())
            {
                try
                {
                    var c = await _api.GetPhotoCatalogAsync(ct);
                    if (c != null && c.Enabled) Catalog = c;
                }
                catch (ApiException) { Catalog = PhotoCatalog.Offline(); }
            }
            else Catalog = PhotoCatalog.Offline();
            Spec.Camera = PhotoCamera.Clamp(Spec.Camera, Catalog.Camera, Snapshot.States.Length);
            // drop anything no longer usable (another device, a catalog change)
            if (!IsUsable("looks", Spec.LookId)) Spec.LookId = Catalog.Looks.FirstOrDefault(x => x.Unlocked)?.Id ?? "natural";
            if (Spec.FrameId != null && !IsUsable("frames", Spec.FrameId)) Spec.FrameId = null;
            Spec.Stamps.RemoveAll(s => !IsUsable("stamps", s.Id));
        }

        private bool IsUsable(string cat, string id) => Catalog.Find(cat, id)?.Unlocked == true;

        private static PhotoLock LockOf(PhotoItem it) => new PhotoLock { Item = it, Text = it.UnlockText, Buyable = it.Buyable };

        /// <summary>Buy a shop frame / stamp at its fixed price (the cosmetics shop path), then reload the catalog.</summary>
        public async Task<CosmeticPurchase> BuyAsync(PhotoItem item, CancellationToken ct = default)
        {
            if (item == null || !item.Buyable) throw new InvalidOperationException("not for sale");
            var r = await _api.BuyCosmeticAsync(item.Unlock.ItemId, null, ct);
            await LoadCatalogAsync(ct);
            return r;
        }

        // ------------------------------------------------------------------------------------------- camera

        public RaceCameraShot Shot => PhotoCamera.Shot(Snapshot, Spec.Camera, Catalog.Camera, _visuals?.Track);
        private void Cam(Action<PhotoCameraParams> f) { var c = Spec.Camera.Clone(); f(c); Spec.Camera = PhotoCamera.Clamp(c, Catalog.Camera, Snapshot.States.Length); }
        public void Orbit(int deltaDeg) => Cam(c => c.OrbitDeg += deltaDeg);
        public void Zoom(int deltaDm) => Cam(c => c.DistanceDm += deltaDm);
        public void Raise(int deltaDm) => Cam(c => c.HeightDm += deltaDm);
        public void Fov(int deltaDeg) => Cam(c => c.FovDeg += deltaDeg);
        public void SetDof(int level) => Cam(c => c.Dof = level);
        public void Focus(int slot) => Cam(c => c.FocusSlot = slot);
        public void ResetCamera() => Spec.Camera = PhotoCamera.Clamp(new PhotoCameraParams { FocusSlot = Spec.Camera.FocusSlot }, Catalog.Camera, Snapshot.States.Length);

        // ------------------------------------------------------------------------------------------- overlays

        /// <summary>Apply a look (all looks are free). Returns null, or the lock of an item not usable yet.</summary>
        public PhotoLock SelectLook(string id)
        {
            var it = Catalog.Find("looks", id) ?? throw new ArgumentException("unknown look " + id);
            if (!it.Unlocked) return LockOf(it);
            Spec.LookId = id;
            return null;
        }

        /// <summary>Apply a frame (null = none).</summary>
        public PhotoLock SelectFrame(string id)
        {
            if (id == null) { Spec.FrameId = null; return null; }
            var it = Catalog.Find("frames", id) ?? throw new ArgumentException("unknown frame " + id);
            if (!it.Unlocked) return LockOf(it);
            Spec.FrameId = id;
            return null;
        }

        /// <summary>Place a stamp (centre of the picture; move it with <see cref="MoveStamp"/>). At most StampsMax.</summary>
        public PhotoLock AddStamp(string id)
        {
            var it = Catalog.Find("stamps", id) ?? throw new ArgumentException("unknown stamp " + id);
            if (!it.Unlocked) return LockOf(it);
            if (Spec.Stamps.Count >= Catalog.StampsMax) return null;
            Spec.Stamps.Add(new PhotoStampPlacement { Id = id });
            return null;
        }

        public void MoveStamp(int index, int xPermille, int yPermille, int scalePermille = 1000, int rotDeg = 0)
        {
            var s = Spec.Stamps[index];
            s.XPermille = Math.Max(0, Math.Min(1000, xPermille));
            s.YPermille = Math.Max(0, Math.Min(1000, yPermille));
            s.ScalePermille = Math.Max(250, Math.Min(2000, scalePermille));
            s.RotDeg = Math.Max(-180, Math.Min(180, rotDeg));
        }

        public void RemoveStamp(int index) { if (index >= 0 && index < Spec.Stamps.Count) Spec.Stamps.RemoveAt(index); }

        /// <summary>REQ-PHOTO-007: set the caption; <see cref="CaptionProblem"/> says what is wrong (the photo keeps the last good one).</summary>
        public bool SetCaption(string text)
        {
            CaptionProblem = PhotoCaption.Problem(text, Catalog.CaptionMaxChars);
            if (CaptionProblem != null) return false;
            Spec.Caption = PhotoCaption.Normalize(text);
            return true;
        }

        /// <summary>REQ-PHOTO-008: masked plates ⇄ no plates.</summary>
        public void ToggleNames() => Spec.Names = Spec.Names == PhotoNameModes.Hidden ? PhotoNameModes.Masked : PhotoNameModes.Hidden;
        public string NamesLabel => Spec.Names == PhotoNameModes.Hidden ? NamesShownLabel : NamesHiddenLabel;
        /// <summary>REQ-PHOTO-009: hide the editing panels to check the composition (the photo never has a HUD).</summary>
        public void ToggleHideUi() => HideUi = !HideUi;

        public List<PhotoNamePlate> Plates => PhotoNames.Plates(Snapshot.Config, PlayerSlot, _friends, Spec.Names);

        // ------------------------------------------------------------------------------------------- shutter, share, save

        /// <summary>The share card for the current settings (the replay share card with the photo overlays).</summary>
        public ShareCard Card() => PhotoShareCard.Build(Snapshot, Spec, PlayerSlot, _courseName, _friends);

        /// <summary>The posed scene for the recorder (horses and camera in world space).</summary>
        public PosedPhoto Pose()
        {
            var shot = Shot;
            var frame = Snapshot.ToFrame(shot);
            var cf = CourseFrame.For(Snapshot.Config, _visuals);
            var horses = new WorldPose[Snapshot.States.Length];
            for (int s = 0; s < horses.Length; s++) horses[s] = cf.Horse(Snapshot.States[s], Snapshot.States[s], 1000);
            return new PosedPhoto { Frame = frame, Horses = horses, Camera = cf.ToWorld(shot), Dof = Spec.Camera.Dof, LookAsset = AssetKeys.PhotoLook(Spec.LookId) };
        }

        /// <summary>The shutter: photo_take, and a fresh save key (a retried save of this picture never stores two).</summary>
        public ShareCard Take()
        {
            _saveKey = Guid.NewGuid().ToString("N");
            _track?.Invoke(AnalyticsEvent.PhotoTake(_clock(), Spec.Source.Kind, Spec.LookId));
            return Card();
        }

        /// <summary>Render the still through the replay share recorder and open the share sheet. photo_share only when shared.</summary>
        public async Task<PhotoOutcomeKind> ShareAsync(IClipRecorder recorder, IShareSheet sheet, Action<PosedPhoto> applyPose, CancellationToken ct = default)
        {
            if (recorder == null) throw new ArgumentNullException(nameof(recorder));
            if (sheet == null) throw new ArgumentNullException(nameof(sheet));
            var card = Card();
            var posed = Pose();
            string path;
            try
            {
                applyPose?.Invoke(posed);
                path = await recorder.CaptureStillAsync(posed.Frame, card, ct);
            }
            catch (OperationCanceledException) { recorder.Cancel(); return PhotoOutcomeKind.Cancelled; }
            catch (Exception) { recorder.Cancel(); Message = FailedText; return PhotoOutcomeKind.Failed; }
            if (string.IsNullOrEmpty(path)) { Message = FailedText; return PhotoOutcomeKind.Failed; }
            bool shared;
            try { shared = await sheet.ShareAsync(path, card.ShareText, ct); }
            catch (OperationCanceledException) { shared = false; }
            if (!shared) return PhotoOutcomeKind.Cancelled;
            _track?.Invoke(AnalyticsEvent.PhotoShare(_clock(), Spec.Source.Kind, Spec.FrameId != null));
            return PhotoOutcomeKind.Shared;
        }

        /// <summary>Save the small record (online only). Returns the list after the save, or null with <see cref="Message"/>.</summary>
        public async Task<PhotoList> SaveAsync(CancellationToken ct = default)
        {
            if (Busy) return null;
            if (!_online()) { Message = OfflineSaveText; return null; }
            _saveKey ??= Guid.NewGuid().ToString("N");
            Busy = true;
            try
            {
                var r = await _api.SavePhotoAsync(Spec, _saveKey, ct);
                Message = SavedText;
                return r;
            }
            catch (ApiException e)
            {
                Message = e.Code == ApiErrorCode.PhotoLimit ? FullText : UxText.For(e);
                if (e.Code == ApiErrorCode.PhotoLocked) await LoadCatalogAsync(ct);
                return null;
            }
            finally { Busy = false; }
        }
    }
}
