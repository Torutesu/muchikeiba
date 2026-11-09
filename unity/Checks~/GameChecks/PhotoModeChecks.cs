// フォトモード (REQ-PHOTO-001..018, contracts/protocol.md §38): PhotoModeModel over a fake API. A solo practice race pauses
// (never an online race), the snapshot equals the paused race and the race resumes and finishes with the same hash as an
// untouched twin; the camera stays in the limits and above the course; locked items return their lock and a shop item is
// bought through the cosmetics path; captions follow the wording rules; plates mask strangers; the share goes through the
// replay share recorder with the overlays; photo_take / photo_share; saving is keyed, offline says so, the cap is shown.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class PhotoModeChecks
{
    sealed class FakeApi : IPhotoApi
    {
        public readonly List<string> Calls = new List<string>();
        public readonly List<string> Keys = new List<string>();
        public bool Owned, Full;
        public PhotoCatalog Catalog()
        {
            var c = PhotoCatalog.Offline();
            c.Version = 1;
            c.Frames.Add(new PhotoItem { Id = "victory", Name = "勝利の額縁", Asset = "photo/frame/victory", Unlock = new PhotoUnlock { Kind = "achievement", AchievementId = "wins", Tier = 1 }, UnlockText = "実績「勝利の記録」の1段目で解放", Unlocked = false });
            c.Stamps.Add(new PhotoItem { Id = "carrot_pop", Name = "にんじんポップ", Asset = "photo/stamp/carrot_pop", Unlock = new PhotoUnlock { Kind = "cosmetic", ItemId = "photo_stamp_carrot_pop" }, UnlockText = "見た目ショップで購入（100コイン）", Price = 100, Currency = "any", Unlocked = Owned });
            return c;
        }
        public Task<PhotoCatalog> GetPhotoCatalogAsync(CancellationToken ct = default) { Calls.Add("catalog"); return Task.FromResult(Catalog()); }
        public Task<PhotoList> GetPhotosAsync(CancellationToken ct = default) { Calls.Add("list"); return Task.FromResult(new PhotoList { Max = 30 }); }
        public Task<PhotoList> SavePhotoAsync(PhotoSpec spec, string key = null, CancellationToken ct = default)
        {
            Calls.Add("save"); Keys.Add(key);
            if (Full) throw new ConflictException(ApiErrorCode.PhotoLimit, "PHOTO_LIMIT", "at most 30 photos", 409);
            return Task.FromResult(new PhotoList { Saved = new PhotoRecord { Id = "ph_1", Spec = spec }, Count = 1, Max = 30 });
        }
        public Task<PhotoList> DeletePhotoAsync(string photoId, CancellationToken ct = default) { Calls.Add("delete"); return Task.FromResult(new PhotoList { Max = 30 }); }
        public Task<CosmeticPurchase> BuyCosmeticAsync(string itemId, string key = null, CancellationToken ct = default) { Calls.Add("buy:" + itemId); Owned = true; return Task.FromResult(new CosmeticPurchase { ItemId = itemId }); }
    }

    sealed class FakeRecorder : IClipRecorder
    {
        public int Stills;
        public ShareCard Card;
        public ReplayClipFrame Frame;
        public bool SupportsVideo => false;
        public void Begin(ReplayClip clip, ShareCard card) { }
        public Task CaptureFrameAsync(ReplayClipFrame frame, CancellationToken ct) => Task.CompletedTask;
        public Task<string> FinishAsync(CancellationToken ct) => Task.FromResult<string>(null);
        public Task<string> CaptureStillAsync(ReplayClipFrame frame, ShareCard card, CancellationToken ct) { Stills++; Card = card; Frame = frame; return Task.FromResult("/tmp/photo.png"); }
        public void Cancel() { }
    }

    sealed class FakeSheet : IShareSheet
    {
        public bool Answer = true;
        public string Text;
        public Task<bool> ShareAsync(string filePath, string text, CancellationToken ct) { Text = text; return Task.FromResult(Answer); }
    }

    /// <summary>A practice race ridden to <paramref name="frames"/> frames (start, a few whips).</summary>
    static OfflineRaceDriver Ride(RulesetParams rs, ulong seed, int frames, ref long now)
    {
        var d = new OfflineRaceDriver(RaceFactory.Practice(rs, RaceFactory.DefaultPartner("アカツキ"), seed), 0, autoStart: true);
        var input = new RaceInput();
        for (int f = 0; f < frames && !d.Done; f++)
        {
            var me = d.Sim.GetHorse(0);
            if (me.Departed && f % 90 == 0) input.Spur();
            d.Input(input.Collect(me));
            d.Update(now);
            now += 16;
        }
        return d;
    }

    public static async Task Run(Action<bool, string> check, RulesetParams rs, string root)
    {
        long now = 5_000_000;
        var events = new List<AnalyticsEvent>();
        var api = new FakeApi();

        // ---------------------------------------------------------------- pause a solo race (REQ-PHOTO-001/002)
        var d = Ride(rs, 31, 900, ref now);
        long tw = 5_000_000;
        var twin = Ride(rs, 31, 900, ref tw);
        check(PhotoModeModel.CanPause(d), "a running practice race can be paused for a photo");
        check(!PhotoModeModel.CanPause(null), "no driver: no photo button");
        int tick = d.Sim.Tick;
        string sum = d.Sim.ComputeChecksum();
        var pm = PhotoModeModel.OpenPaused(d, api, null, "練習コース", new Dictionary<string, string>(), () => true, events.Add, () => now);
        check(pm != null && d.Race.IsPaused, "opening photo mode pauses the race");
        check(pm.Snapshot.Tick == tick && pm.Snapshot.Fingerprint == sum, "the snapshot is the paused race's own state (checksum " + sum.Substring(0, 8) + ")");
        check(pm.Spec.Source.Kind == "paused" && pm.Spec.Source.Mode == "practice" && pm.Spec.Source.Tick == tick && pm.Spec.Source.RaceId.StartsWith("local:"), "source = (local race id, tick), mode practice: " + pm.Spec.Source.RaceId);
        for (int i = 0; i < 30; i++) { d.Update(now); now += 16; }
        check(d.Sim.Tick == tick, "the race does not move while photo mode is open");

        // ---------------------------------------------------------------- catalog, camera, overlays
        await pm.LoadCatalogAsync();
        check(api.Calls.Contains("catalog") && pm.Catalog.Looks.Count == 5, "the catalog comes from the server (5 free looks)");
        pm.Orbit(400); pm.Zoom(5000); pm.Raise(-500); pm.Fov(-100); pm.SetDof(9); pm.Focus(99);
        var cam = pm.Spec.Camera;
        check(PhotoCamera.Valid(cam, pm.Catalog.Camera, d.Config.Entrants.Count) && cam.HeightDm == PhotoCameraLimits.MinHeightDm && cam.DistanceDm == 200 && cam.Dof == 3,
            "the camera stays inside the limits and above the course: " + cam);
        check(pm.Shot.Height >= 0.3f, "shot height " + pm.Shot.Height + " m (never under the track)");
        pm.ResetCamera();
        pm.Focus(0);
        check(RaceCameraRig.InFrame(pm.Shot, pm.Snapshot.PoseOf(0, d.Visuals?.Track), PhotoCamera.LookAtHeightM), "the reset camera frames the partner");
        check(pm.SelectLook("mono") == null && pm.Spec.LookId == "mono", "every look is free");
        var lockV = pm.SelectFrame("victory");
        check(lockV != null && !lockV.Buyable && lockV.Text == "実績「勝利の記録」の1段目で解放" && pm.Spec.FrameId == null, "an achievement frame is locked with its unlock text");
        var lockC = pm.AddStamp("carrot_pop");
        check(lockC != null && lockC.Buyable && pm.Spec.Stamps.Count == 0, "a shop stamp is locked and offered in the cosmetics shop");
        await pm.BuyAsync(lockC.Item);
        check(api.Calls.Contains("buy:photo_stamp_carrot_pop") && pm.AddStamp("carrot_pop") == null && pm.Spec.Stamps.Count == 1, "bought at its fixed price through the cosmetics shop, then usable");
        pm.AddStamp("hoof"); pm.AddStamp("star"); pm.AddStamp("muchi");
        check(pm.Spec.Stamps.Count == 3, "at most 3 stamps");
        pm.MoveStamp(0, 2000, -5, 9000, 400);
        var st0 = pm.Spec.Stamps[0];
        check(st0.XPermille == 1000 && st0.YPermille == 0 && st0.ScalePermille == 2000 && st0.RotDeg == 180, "stamp placement is clamped to the picture");
        check(pm.SelectFrame("plain") == null, "a free frame applies");
        check(!pm.SetCaption("馬券が当たった") && pm.CaptionProblem == PhotoCaption.TextWording, "betting words are refused in a caption");
        check(!pm.SetCaption("https://x.example") && pm.CaptionProblem == PhotoCaption.TextUrl, "no URLs in a caption");
        check(pm.SetCaption(" ゴール前の一閃 ") && pm.Spec.Caption == "ゴール前の一閃" && pm.CaptionProblem == null, "a caption is normalised");
        check(pm.Plates.Count == d.Config.Entrants.Count && pm.Plates[0].Rider == "あなた" && pm.Plates.Skip(1).All(p => p.Rider == "CPU"), "plates: you and CPU runners");
        pm.ToggleNames();
        check(pm.Plates.Count == 0 && pm.Spec.Names == "hidden" && pm.NamesLabel == PhotoModeModel.NamesShownLabel, "names can be hidden");
        pm.ToggleNames();
        pm.ToggleHideUi();
        check(pm.HideUi, "the editing UI can be hidden");

        // ---------------------------------------------------------------- shutter, share, save (REQ-PHOTO-009/010/014)
        var card = pm.Take();
        check(events.Count(e => e.Name == "photo_take") == 1, "photo_take on the shutter");
        check(card.Kind == "photo_image" && card.Watermark == ShareCard.GameTitle && card.Photo.FrameAsset == "photo/frame/plain" && card.Photo.LookAsset == "photo/look/mono" && card.Photo.StampAssets.Count == 3,
            "the share card carries the logo and the overlays");
        var rec = new FakeRecorder();
        var sheet = new FakeSheet { Answer = false };
        PosedPhoto posed = null;
        var outc = await pm.ShareAsync(rec, sheet, p => posed = p);
        check(outc == PhotoOutcomeKind.Cancelled && !events.Any(e => e.Name == "photo_share"), "a cancelled share sends nothing");
        sheet.Answer = true;
        outc = await pm.ShareAsync(rec, sheet, p => posed = p);
        check(outc == PhotoOutcomeKind.Shared && events.Count(e => e.Name == "photo_share") == 1, "photo_share only when shared");
        check(rec.Stills == 2 && rec.Frame.Tick == tick && posed != null && posed.Horses.Length == d.Config.Entrants.Count && posed.Dof == pm.Spec.Camera.Dof, "the still goes through the replay share recorder at the photo tick");
        check(sheet.Text.Contains("ゴール前の一閃") && sheet.Text.EndsWith(ShareCard.Hashtag), "share text: horse, course, your caption, hashtag: " + sheet.Text);
        var saved = await pm.SaveAsync();
        var again = await pm.SaveAsync();
        check(saved?.Saved?.Id == "ph_1" && pm.Message == PhotoModeModel.SavedText && api.Keys.Count == 2 && api.Keys[0] == api.Keys[1], "saving is keyed: a retry of the same picture uses the same key");
        api.Full = true;
        pm.Take();
        check(await pm.SaveAsync() == null && pm.Message == PhotoModeModel.FullText, "the cap is explained");

        // ---------------------------------------------------------------- close resumes the race; hash unchanged
        pm.Close();
        check(!d.Race.IsPaused, "closing photo mode resumes the race");
        for (int f = 0; f < 60 * 400 && !d.Done; f++) { d.Update(now); now += 16; }
        for (int f = 0; f < 60 * 400 && !twin.Done; f++) { twin.Update(tw); tw += 16; }
        check(d.Done && twin.Done && d.Sim.Result.Hash == twin.Sim.Result.Hash, "the photographed race finishes with the same hash as an untouched twin");

        // ---------------------------------------------------------------- result / replay entry, offline
        check(!PhotoModeModel.CanPause(d) && PhotoModeModel.CanOpenFromResult(d), "a finished race: no pause, but the result screen can open photo mode");
        var off = PhotoModeModel.OpenFromResult(d, api, "r_1", null, null, () => false, events.Add, () => now);
        await off.LoadCatalogAsync();
        check(off.Spec.Source.Kind == "result" && off.Catalog.Version == 0 && off.Catalog.Frames.All(f => f.Unlocked), "offline: the free items of the shipped catalog");
        check(await off.SaveAsync() == null && off.Message == PhotoModeModel.OfflineSaveText, "offline: saving waits for the network, sharing still works");
        var me = d.Sim.GetHorse(0);
        check(off.Snapshot.Tick == Math.Min(me.FinishTick + 1, d.Sim.Tick), "the result photo is the moment the partner crossed the line (tick " + off.Snapshot.Tick + ")");
        var rp = PhotoModeModel.OpenFromReplay(d.Config, d.Race.AllInputs(), 300, 0, "ranked", "r_9", api);
        check(rp.Spec.Source.Kind == "replay" && rp.Spec.Source.Mode == "ranked" && rp.Snapshot.Tick == 300, "the replay player opens photo mode at its tick (any mode)");

        // English
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        Loc.SetLocale("en");
        try
        {
            var texts = new[] { PhotoModeModel.Title, PhotoModeModel.OfflineSaveText, PhotoModeModel.SavedText, PhotoModeModel.FullText, PhotoModeModel.HideUiLabel, PhotoModeModel.NamesShownLabel, PhotoModeModel.NamesHiddenLabel,
                PhotoCaption.TextUrl, PhotoCaption.TextWording, PhotoCaption.Problem(new string('あ', 30)), PhotoNames.YouLabel, PhotoModeModel.LockedLabel, PhotoModeModel.FailedText, "ナチュラル", lockV.Text };
            var bad = texts.Where(t => Loc.HasJapanese(Loc.T(t))).ToList();
            check(bad.Count == 0, "photo mode texts read in English" + (bad.Count > 0 ? ": missing " + string.Join(" | ", bad) : ""));
        }
        finally { Loc.SetLocale("ja"); }
    }
}
