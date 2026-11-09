using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // =====================================================================================================
    // フォトモード (REQ-PHOTO-001..018, contracts/protocol.md §38, server/src/domain/photoMode.ts).
    //
    // A photo is (race, tick) + camera + overlays. The device re-simulates the race from its config and inputs up to the
    // tick (PhotoSnapshot, the same stepping as ReplayClip / RaceReplay) so the picture can be rebuilt at any time; the
    // live RaceSim is never touched and no race state, hash or golden changes. The camera (PhotoCamera) orbits the focus
    // horse within the catalog's limits and never goes under the course. The share image goes through the replay share
    // path (ShareCard + IClipRecorder.CaptureStillAsync + IShareSheet) with the photo overlays on the card. Floating
    // point is used only for display (camera), like RaceCameraRig.
    // =====================================================================================================

    /// <summary>How a look / frame / stamp unlocks. Kind: default | achievement | cosmetic.</summary>
    public sealed class PhotoUnlock
    {
        public string Kind, AchievementId, ItemId;
        public int Tier;
        internal static PhotoUnlock Parse(JsonNode o) => new PhotoUnlock { Kind = J.Str(o, "kind"), AchievementId = J.Str(o, "achievementId"), Tier = J.Int(o, "tier"), ItemId = J.Str(o, "itemId") };
    }

    /// <summary>One look (filter), frame or stamp of GET /v1/photo/catalog.</summary>
    public sealed class PhotoItem
    {
        public string Id, Name, Asset, UnlockText, Currency;
        public PhotoUnlock Unlock;
        public bool Unlocked;
        /// <summary>Coins, only for items sold in the cosmetics shop (Unlock.Kind == "cosmetic"); buy with BuyCosmeticAsync(Unlock.ItemId).</summary>
        public int? Price;
        public bool Buyable => !Unlocked && Unlock?.Kind == "cosmetic" && Price.HasValue;
        internal static PhotoItem Parse(JsonNode o) => new PhotoItem
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Asset = J.Str(o, "asset"), Unlock = PhotoUnlock.Parse(J.Opt(o, "unlock")),
            UnlockText = J.Str(o, "unlockText"), Unlocked = J.Bool(o, "unlocked"), Price = J.IntN(o, "price"), Currency = J.Str(o, "currency"),
        };
    }

    /// <summary>Inclusive integer range [Lo, Hi].</summary>
    public struct PhotoRange
    {
        public int Lo, Hi;
        public PhotoRange(int lo, int hi) { Lo = lo; Hi = hi; }
        public int Clamp(int v) => v < Lo ? Lo : v > Hi ? Hi : v;
        public bool Contains(int v) => v >= Lo && v <= Hi;
        internal static PhotoRange Parse(JsonNode o, string k, PhotoRange def)
        {
            var a = J.Ints(o, k);
            return a != null && a.Length == 2 ? new PhotoRange(a[0], a[1]) : def;
        }
    }

    /// <summary>The camera limits (photo.json config.camera; the server checks the same ranges).</summary>
    public sealed class PhotoCameraLimits
    {
        /// <summary>The camera never goes lower than this (0.3 m): never under the course (REQ-PHOTO-003).</summary>
        public const int MinHeightDm = 3;
        public PhotoRange OrbitDeg = new PhotoRange(-180, 180), DistanceDm = new PhotoRange(20, 200), HeightDm = new PhotoRange(3, 100), FovDeg = new PhotoRange(20, 70), Dof = new PhotoRange(0, 3);
        public static PhotoCameraLimits Default => new PhotoCameraLimits();
        internal static PhotoCameraLimits Parse(JsonNode o)
        {
            var d = Default;
            if (o == null) return d;
            return new PhotoCameraLimits
            {
                OrbitDeg = PhotoRange.Parse(o, "orbitDeg", d.OrbitDeg), DistanceDm = PhotoRange.Parse(o, "distanceDm", d.DistanceDm),
                HeightDm = PhotoRange.Parse(o, "heightDm", d.HeightDm), FovDeg = PhotoRange.Parse(o, "fovDeg", d.FovDeg), Dof = PhotoRange.Parse(o, "dof", d.Dof),
            };
        }
    }

    /// <summary>GET /v1/photo/catalog. Enabled false = photo mode is off (hide the entry points).</summary>
    public sealed class PhotoCatalog
    {
        public bool Enabled;
        public int Version, MaxSaved = 30, CaptionMaxChars = PhotoCaption.DefaultMaxChars, StampsMax = 3;
        public PhotoCameraLimits Camera = PhotoCameraLimits.Default;
        public List<PhotoItem> Looks = new List<PhotoItem>(), Frames = new List<PhotoItem>(), Stamps = new List<PhotoItem>();
        public string Notice;
        internal static PhotoCatalog Parse(JsonNode o)
        {
            var l = J.Opt(o, "limits");
            return new PhotoCatalog
            {
                Enabled = J.Bool(o, "enabled"), Version = J.Int(o, "version"),
                MaxSaved = J.Int(l, "maxSaved", 30), CaptionMaxChars = J.Int(l, "captionMaxChars", PhotoCaption.DefaultMaxChars), StampsMax = J.Int(l, "stampsMax", 3),
                Camera = PhotoCameraLimits.Parse(J.Opt(l, "camera")),
                Looks = J.List(o, "looks", PhotoItem.Parse), Frames = J.List(o, "frames", PhotoItem.Parse), Stamps = J.List(o, "stamps", PhotoItem.Parse),
                Notice = J.Str(o, "notice"),
            };
        }

        /// <summary>
        /// What the device can use without the server (offline, or before the catalog loaded): the free looks and the free
        /// frame / stamp ids of the shipped catalog. Names are the Japanese master names (Loc.T translates them).
        /// </summary>
        public static PhotoCatalog Offline()
        {
            PhotoItem Free(string cat, string id, string name) => new PhotoItem { Id = id, Name = name, Asset = "photo/" + cat + "/" + id, Unlock = new PhotoUnlock { Kind = "default" }, UnlockText = "最初から使える", Unlocked = true };
            var c = new PhotoCatalog { Enabled = true, Version = 0 };
            c.Looks.AddRange(new[] { Free("look", "natural", "ナチュラル"), Free("look", "film", "フィルム"), Free("look", "mono", "モノクロ"), Free("look", "dusk", "夕暮れ"), Free("look", "vivid", "ビビッド") });
            c.Frames.AddRange(new[] { Free("frame", "plain", "シンプル"), Free("frame", "gate", "ゲート") });
            c.Stamps.AddRange(new[] { Free("stamp", "muchi", "筆文字"), Free("stamp", "hoof", "蹄あと"), Free("stamp", "star", "きらり") });
            return c;
        }

        public PhotoItem Find(string category, string id)
        {
            var list = category == "looks" ? Looks : category == "frames" ? Frames : category == "stamps" ? Stamps : null;
            return list?.Find(x => x.Id == id);
        }
    }

    public static class PhotoSourceKinds
    {
        /// <summary>A solo race paused while running (never a race run with other people).</summary>
        public const string Paused = "paused";
        /// <summary>The result screen of a finished race (any mode).</summary>
        public const string Result = "result";
        /// <summary>A replay being watched.</summary>
        public const string Replay = "replay";
    }

    /// <summary>Where the picture comes from: (race, tick).</summary>
    public sealed class PhotoSource
    {
        public string Kind = PhotoSourceKinds.Result, Mode = "practice", RaceId;
        /// <summary>§37: the player's own saved replay the photo was taken from (= its raceId; null otherwise).</summary>
        public string ReplayId;
        public int Tick;
        internal static PhotoSource Parse(JsonNode o) => new PhotoSource { Kind = J.Str(o, "kind"), Mode = J.Str(o, "mode"), RaceId = J.Str(o, "raceId"), Tick = J.Int(o, "tick"), ReplayId = J.Str(o, "replayId") };
        /// <summary>The wire form (POST /v1/photos `source`).</summary>
        public JsonNode ToJson()
        {
            var o = JsonNode.Obj().Set("kind", Kind).Set("mode", Mode).Set("raceId", RaceId).Set("tick", Tick);
            if (!string.IsNullOrEmpty(ReplayId)) o.Set("replayId", ReplayId);
            return o;
        }

        /// <summary>
        /// The wire mode of a race (photo record `source.mode`). A race the device runs alone (offline practice, which uses a
        /// Friend config, the offline time attack…) is "practice" unless it is a tutorial / time attack / weekly challenge.
        /// </summary>
        public static string ModeOf(RaceMode mode, bool online)
        {
            if (!online)
                return mode == RaceMode.Tutorial ? "tutorial" : mode == RaceMode.TimeAttack ? "time_attack" : mode == RaceMode.Challenge ? "challenge" : "practice";
            switch (mode)
            {
                case RaceMode.Ranked: return "ranked";
                case RaceMode.Friend: return "friend";
                case RaceMode.Tutorial: return "tutorial";
                case RaceMode.TimeAttack: return "time_attack";
                case RaceMode.Event: return "event";
                case RaceMode.Tournament: return "tournament";
                case RaceMode.Challenge: return "challenge";
                default: return online ? "ranked" : "practice";
            }
        }

        /// <summary>REQ-PHOTO-001: modes raced together with other people (never paused live).</summary>
        public static bool IsShared(string mode) => mode == "ranked" || mode == "friend" || mode == "event" || mode == "tournament";
    }

    /// <summary>Camera values as the server stores them: integers (degrees, decimetres).</summary>
    public sealed class PhotoCameraParams
    {
        public int FocusSlot, OrbitDeg, DistanceDm = 60, HeightDm = 15, FovDeg = 40, Dof;
        public PhotoCameraParams Clone() => (PhotoCameraParams)MemberwiseClone();
        internal static PhotoCameraParams Parse(JsonNode o) => new PhotoCameraParams
        {
            FocusSlot = J.Int(o, "focusSlot"), OrbitDeg = J.Int(o, "orbitDeg"), DistanceDm = J.Int(o, "distanceDm"), HeightDm = J.Int(o, "heightDm"), FovDeg = J.Int(o, "fovDeg"), Dof = J.Int(o, "dof"),
        };
        internal JsonNode ToJson() => JsonNode.Obj().Set("focusSlot", FocusSlot).Set("orbitDeg", OrbitDeg).Set("distanceDm", DistanceDm).Set("heightDm", HeightDm).Set("fovDeg", FovDeg).Set("dof", Dof);
        public override string ToString() => "slot " + FocusSlot + " orbit " + OrbitDeg + " d" + DistanceDm + " h" + HeightDm + " fov" + FovDeg + " dof" + Dof;
    }

    /// <summary>A stamp placed on the picture (position and size in permille of the image).</summary>
    public sealed class PhotoStampPlacement
    {
        public string Id;
        public int XPermille = 500, YPermille = 500, ScalePermille = 1000, RotDeg;
        internal static PhotoStampPlacement Parse(JsonNode o) => new PhotoStampPlacement { Id = J.Str(o, "id"), XPermille = J.Int(o, "xPermille"), YPermille = J.Int(o, "yPermille"), ScalePermille = J.Int(o, "scalePermille"), RotDeg = J.Int(o, "rotDeg") };
        internal JsonNode ToJson() => JsonNode.Obj().Set("id", Id).Set("xPermille", XPermille).Set("yPermille", YPermille).Set("scalePermille", ScalePermille).Set("rotDeg", RotDeg);
    }

    public static class PhotoNameModes
    {
        /// <summary>Your name, friends' names, p&lt;slot&gt; for other people, CPU for CPU runners (the default).</summary>
        public const string Masked = "masked";
        /// <summary>No name plates at all.</summary>
        public const string Hidden = "hidden";
    }

    /// <summary>Everything that makes the picture (a photo record without id / time).</summary>
    public sealed class PhotoSpec
    {
        public PhotoSource Source = new PhotoSource();
        public PhotoCameraParams Camera = new PhotoCameraParams();
        public string LookId = "natural", FrameId, Caption, Names = PhotoNameModes.Masked;
        public List<PhotoStampPlacement> Stamps = new List<PhotoStampPlacement>();
        public bool HideUi = true;
        internal JsonNode ToJson()
        {
            var st = JsonNode.Arr();
            foreach (var s in Stamps) st.Add(s.ToJson());
            return JsonNode.Obj().Set("source", Source.ToJson()).Set("camera", Camera.ToJson()).Set("lookId", LookId).Set("frameId", FrameId).Set("stamps", st)
                .Set("caption", string.IsNullOrEmpty(Caption) ? null : Caption).Set("names", Names).Set("hideUi", HideUi);
        }
    }

    /// <summary>A saved photo record (GET /v1/photos). The image itself is never stored: rebuild it from the spec.</summary>
    public sealed class PhotoRecord
    {
        public string Id;
        public long CreatedAt;
        public PhotoSpec Spec;
        /// <summary>§37: the saved replay it points at is still saved (offer 「リプレイを見る」). False without one.</summary>
        public bool ReplaySaved;
        internal static PhotoRecord Parse(JsonNode o) => new PhotoRecord
        {
            Id = J.Str(o, "id"), CreatedAt = J.Long(o, "createdAt"), ReplaySaved = J.Bool(o, "replaySaved", false),
            Spec = new PhotoSpec
            {
                Source = PhotoSource.Parse(J.Opt(o, "source")), Camera = PhotoCameraParams.Parse(J.Opt(o, "camera")), LookId = J.Str(o, "lookId"), FrameId = J.Str(o, "frameId"),
                Stamps = J.List(o, "stamps", PhotoStampPlacement.Parse), Caption = J.Str(o, "caption"), Names = J.Str(o, "names") ?? PhotoNameModes.Masked, HideUi = J.Bool(o, "hideUi", true),
            },
        };
    }

    /// <summary>GET /v1/photos, POST /v1/photos and DELETE /v1/photos/:id all answer the count against the cap.</summary>
    public sealed class PhotoList
    {
        public List<PhotoRecord> Photos = new List<PhotoRecord>();
        /// <summary>Only on a save: the stored record.</summary>
        public PhotoRecord Saved;
        public int Count, Max;
        public bool Full => Count >= Max;
        internal static PhotoList Parse(JsonNode o) => new PhotoList
        {
            Photos = J.List(o, "photos", PhotoRecord.Parse), Saved = J.Opt(o, "photo") is JsonNode p ? PhotoRecord.Parse(p) : null, Count = J.Int(o, "count"), Max = J.Int(o, "max"),
        };
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-PHOTO-006: looks / frames / stamps with this player's unlocks and the limits.</summary>
        public Task<PhotoCatalog> GetPhotoCatalogAsync(CancellationToken ct = default)
            => Call("GET", "/v1/photo/catalog", null, true, null, true, PhotoCatalog.Parse, ct);

        /// <summary>REQ-PHOTO-010: saved photo records, newest first.</summary>
        public Task<PhotoList> GetPhotosAsync(CancellationToken ct = default)
            => Call("GET", "/v1/photos", null, true, null, true, PhotoList.Parse, ct);

        /// <summary>
        /// REQ-PHOTO-010: save the record (idempotent with the key: a retry returns the first record, never a second one).
        /// ConflictException PHOTO_LIMIT (full) / PHOTO_LOCKED; BadRequest PHOTO_SOURCE_INVALID / INVALID_NAME / NG_NAME.
        /// </summary>
        public Task<PhotoList> SavePhotoAsync(PhotoSpec spec, string idempotencyKey = null, CancellationToken ct = default)
        {
            if (spec == null) throw new ArgumentNullException(nameof(spec));
            if (string.IsNullOrEmpty(spec.Source?.RaceId)) throw new ArgumentException("source.raceId required", nameof(spec));
            return Call("POST", "/v1/photos", spec.ToJson(), true, idempotencyKey ?? NewIdempotencyKey(), true, PhotoList.Parse, ct);
        }

        /// <summary>Delete a saved record (deleting twice is NotFound).</summary>
        public Task<PhotoList> DeletePhotoAsync(string photoId, CancellationToken ct = default)
            => Call("DELETE", "/v1/photos/" + Seg(photoId), null, true, null, false, PhotoList.Parse, ct);
    }

    /// <summary>
    /// The free camera of photo mode (REQ-PHOTO-003): orbits the focus horse (0° = behind it, 90° = its outside, 180° =
    /// in front), at a horizontal distance and a height, with a field of view. Values are clamped to the limits and the
    /// camera never goes under the course surface (Y = 0 + 0.3 m). RENDER-ONLY: never fed back into the simulation.
    /// </summary>
    public static class PhotoCamera
    {
        public const double LookAtHeightM = 1.2;

        /// <summary>The same values clamped to <paramref name="limits"/> (orbit wraps around instead of stopping).</summary>
        public static PhotoCameraParams Clamp(PhotoCameraParams p, PhotoCameraLimits limits, int runners)
        {
            limits = limits ?? PhotoCameraLimits.Default;
            var c = p.Clone();
            int o = ((p.OrbitDeg % 360) + 540) % 360 - 180; // wrap into -180..179
            c.OrbitDeg = limits.OrbitDeg.Clamp(o);
            c.DistanceDm = limits.DistanceDm.Clamp(p.DistanceDm);
            c.HeightDm = Math.Max(PhotoCameraLimits.MinHeightDm, limits.HeightDm.Clamp(p.HeightDm));
            c.FovDeg = limits.FovDeg.Clamp(p.FovDeg);
            c.Dof = limits.Dof.Clamp(p.Dof);
            c.FocusSlot = Math.Max(0, Math.Min(Math.Max(0, runners - 1), p.FocusSlot));
            return c;
        }

        /// <summary>Is every value inside the limits (what the server accepts)?</summary>
        public static bool Valid(PhotoCameraParams p, PhotoCameraLimits limits, int runners)
        {
            limits = limits ?? PhotoCameraLimits.Default;
            return limits.OrbitDeg.Contains(p.OrbitDeg) && limits.DistanceDm.Contains(p.DistanceDm) && limits.HeightDm.Contains(p.HeightDm) && p.HeightDm >= PhotoCameraLimits.MinHeightDm
                && limits.FovDeg.Contains(p.FovDeg) && limits.Dof.Contains(p.Dof) && p.FocusSlot >= 0 && p.FocusSlot < runners;
        }

        /// <summary>The camera placement (course space, like RaceCameraRig) for a horse posed at <paramref name="subject"/>.</summary>
        public static RaceCameraShot Shot(TrackPose subject, PhotoCameraParams p)
        {
            double yaw = (subject.YawDegrees + 180 + p.OrbitDeg) * Math.PI / 180; // 0° = behind the horse
            double d = p.DistanceDm / 10.0;
            var pos = new TrackPose { X = (float)(subject.X + Math.Sin(yaw) * d), Y = 0, Z = (float)(subject.Z + Math.Cos(yaw) * d), YawDegrees = (float)((yaw * 180 / Math.PI + 180) % 360) };
            return new RaceCameraShot
            {
                Mode = RaceCameraMode.Finish, Position = pos, Height = (float)(Math.Max(PhotoCameraLimits.MinHeightDm, p.HeightDm) / 10.0),
                LookAt = subject, LookAtHeight = (float)LookAtHeightM, FieldOfViewDegrees = p.FovDeg, StraightBlendPermille = 1000,
            };
        }

        /// <summary>The shot for <paramref name="p"/>.FocusSlot in a snapshot (clamped first).</summary>
        public static RaceCameraShot Shot(PhotoSnapshot snap, PhotoCameraParams p, PhotoCameraLimits limits = null, TrackVisual visual = null)
        {
            var c = Clamp(p, limits, snap.States.Length);
            return Shot(snap.PoseOf(c.FocusSlot, visual), c);
        }
    }

    /// <summary>
    /// The race at one tick, re-simulated from its config and inputs (REQ-PHOTO-002). Holds copies of every horse's state;
    /// building it never touches a live race. <see cref="Fingerprint"/> is the engine checksum of that tick (same inputs →
    /// same fingerprint, and the live race's own checksum when it is paused at that tick).
    /// </summary>
    public sealed class PhotoSnapshot
    {
        public RaceConfig Config { get; private set; }
        /// <summary>States when sim.Tick == Tick (index = slot). Do not modify.</summary>
        public HorseState[] States { get; private set; }
        public int Tick { get; private set; }
        public string Fingerprint { get; private set; }
        /// <summary>The race was over at this tick (the requested tick was later than the end: clamped to the end).</summary>
        public bool AtEnd { get; private set; }

        /// <summary>
        /// Re-simulate <paramref name="config"/> with <paramref name="inputs"/> until sim.Tick == <paramref name="tick"/> (or
        /// the end of the race, whichever is first).
        /// </summary>
        public static PhotoSnapshot Capture(RaceConfig config, IList<InputRecord> inputs, int tick)
        {
            if (config == null) throw new ArgumentNullException(nameof(config));
            if (inputs == null) throw new ArgumentNullException(nameof(inputs));
            if (tick < 0) throw new ArgumentOutOfRangeException(nameof(tick));
            config.Validate();
            var byTick = new SortedDictionary<int, List<InputRecord>>();
            foreach (var r in inputs)
            {
                if (r.Slot < 0 || r.Slot >= config.Entrants.Count) throw new ArgumentException("input slot out of range");
                if (r.Tick < 0 || r.Tick >= config.Ruleset.MaxTicks) throw new ArgumentException("input tick out of range");
                if (!byTick.TryGetValue(r.Tick, out var list)) byTick[r.Tick] = list = new List<InputRecord>();
                list.Add(r);
            }
            var sim = new RaceSim(config);
            var cmds = new byte[config.Entrants.Count];
            while (sim.Tick < tick && !sim.IsFinished)
            {
                Array.Clear(cmds, 0, cmds.Length);
                if (byTick.TryGetValue(sim.Tick, out var list)) foreach (var r in list) cmds[r.Slot] |= r.Cmd;
                sim.Step(cmds);
            }
            int n = config.Entrants.Count;
            var states = new HorseState[n];
            for (int s = 0; s < n; s++) states[s] = sim.GetHorse(s);
            return new PhotoSnapshot { Config = config, States = states, Tick = sim.Tick, Fingerprint = sim.ComputeChecksum(), AtEnd = sim.Tick < tick };
        }

        /// <summary>A paused offline race at its current tick (its own sim is only read, never stepped).</summary>
        public static PhotoSnapshot Capture(OfflineRace race)
        {
            if (race == null) throw new ArgumentNullException(nameof(race));
            return Capture(race.Config, race.AllInputs(), race.Sim.Tick);
        }

        /// <summary>Course-space pose of a horse (TrackGeometry, like ReplayClip.PoseOf).</summary>
        public TrackPose PoseOf(int slot, TrackVisual visual = null)
        {
            var h = States[slot];
            return TrackGeometry.For(Config, visual).PoseOf(h, Config.Ruleset.LaneWidthMm);
        }

        /// <summary>
        /// The still for the share recorder (IClipRecorder.CaptureStillAsync): both states = this tick, posed with the
        /// photo camera.
        /// </summary>
        public ReplayClipFrame ToFrame(RaceCameraShot shot)
        {
            double rem = Math.Max(0, Config.Track.DistanceM - TrackGeometry.DistanceM(States[0].Distance));
            return new ReplayClipFrame { Index = 0, TimeMs = 0, Tick = Tick, AlphaPermille = 1000, From = States, To = States, Camera = shot, FocusRemainingM = rem };
        }
    }

    /// <summary>One name plate in the picture.</summary>
    public struct PhotoNamePlate
    {
        public int Slot;
        public string HorseName;
        /// <summary>「あなた」, a friend's display name, p&lt;slot&gt; or CPU.</summary>
        public string Rider;
        public bool You;
        public override string ToString() => HorseName + " / " + Rider;
    }

    /// <summary>
    /// REQ-PHOTO-008: who the plates name. Your own runner says 「あなた」, a friend shows their display name, every other
    /// human is p&lt;slot&gt; (the same masking as saved replays, §37) and CPU runners say CPU. Hidden = no plates.
    /// </summary>
    public static class PhotoNames
    {
        public const string YouLabel = "あなた";
        public const string CpuLabel = "CPU";

        /// <summary>The masked id of a non-friend human: the §37 rule itself (one implementation, <see cref="ReplayPrivacy"/>).</summary>
        public static string Masked(int slot) => ReplayPrivacy.MaskedId(slot);

        /// <param name="friendNames">Friends' player id → display name (what the friend list shows).</param>
        public static List<PhotoNamePlate> Plates(RaceConfig config, int playerSlot, IReadOnlyDictionary<string, string> friendNames, string mode)
        {
            var list = new List<PhotoNamePlate>();
            if (config == null || mode == PhotoNameModes.Hidden) return list;
            foreach (var e in config.Entrants)
            {
                string rider;
                bool you = e.Slot == playerSlot;
                if (you) rider = YouLabel;
                else if (e.Kind == EntrantKind.Cpu) rider = CpuLabel;
                else if (e.PlayerId != null && friendNames != null && friendNames.TryGetValue(e.PlayerId, out var fn) && !string.IsNullOrEmpty(fn)) rider = fn;
                else rider = Masked(e.Slot);
                list.Add(new PhotoNamePlate { Slot = e.Slot, HorseName = e.Horse?.Name ?? "", Rider = rider, You = you });
            }
            return list;
        }
    }

    /// <summary>
    /// REQ-PHOTO-007: the device-side check of a caption before saving (the server decides; this only spares a round
    /// trip). Same rules: NFKC, length, no control characters / URLs, the shop wording rules and no betting words.
    /// </summary>
    public static class PhotoCaption
    {
        public const int DefaultMaxChars = 24;
        public static readonly string[] BannedWords = { "倍", "お得", "今だけ", "残りわずか", "通常価格", "馬券", "賭け", "賭博", "ベット", "オッズ", "配当", "払戻", "払い戻し", "的中", "予想" };
        public const string TextTooLong = "ひとことは{n}文字までです";
        public const string TextUrl = "ひとことにURLは入れられません";
        public const string TextWording = "この言葉はひとことに使えません";
        private static readonly Regex Url = new Regex(@"https?:|www\.|\.(com|net|jp)\b", RegexOptions.IgnoreCase);

        public static string Normalize(string raw)
        {
            if (raw == null) return null;
            var t = Regex.Replace(raw.Normalize(NormalizationForm.FormKC).Trim(), @"\s+", " ");
            return t.Length == 0 ? null : t;
        }

        /// <summary>Characters as the server counts them (code points, not grapheme clusters).</summary>
        public static int Length(string t)
        {
            if (t == null) return 0;
            int n = 0;
            for (int i = 0; i < t.Length; i++) { n++; if (char.IsHighSurrogate(t[i]) && i + 1 < t.Length && char.IsLowSurrogate(t[i + 1])) i++; }
            return n;
        }

        /// <summary>null when the caption may be sent, else the sentence to show (Japanese; Loc.T for English).</summary>
        public static string Problem(string raw, int maxChars = DefaultMaxChars)
        {
            var t = Normalize(raw);
            if (t == null) return null;
            if (Length(t) > maxChars) return TextTooLong.Replace("{n}", maxChars.ToString(CultureInfo.InvariantCulture));
            foreach (var ch in t) if (char.IsControl(ch)) return TextWording;
            if (Url.IsMatch(t)) return TextUrl;
            foreach (var w in BannedWords) if (t.Contains(w)) return TextWording;
            return null;
        }
    }

    /// <summary>What the share image draws on top of the photo (on <see cref="ShareCard.Photo"/>).</summary>
    public sealed class PhotoOverlay
    {
        public string LookAsset, FrameAsset, Caption;
        public int Dof;
        public List<PhotoStampPlacement> Stamps = new List<PhotoStampPlacement>();
        /// <summary>Asset key per stamp, same order as <see cref="Stamps"/>.</summary>
        public List<string> StampAssets = new List<string>();
        public List<PhotoNamePlate> Plates = new List<PhotoNamePlate>();
        /// <summary>REQ-PHOTO-009: no HUD in a photo (place / time are not drawn); the toggle only hides the editing UI.</summary>
        public bool HideUi = true;
    }

    /// <summary>
    /// REQ-PHOTO-009: the share card of a photo — the replay share card (watermark = the game logo, horse, course, mode)
    /// plus the overlays. The share text names only your horse and the course (and your own caption), never other players.
    /// </summary>
    public static class PhotoShareCard
    {
        public const string Kind = "photo_image";

        public static ShareCard Build(PhotoSnapshot snap, PhotoSpec spec, int playerSlot, string courseName = null, IReadOnlyDictionary<string, string> friendNames = null)
        {
            if (snap == null) throw new ArgumentNullException(nameof(snap));
            if (spec == null) throw new ArgumentNullException(nameof(spec));
            var cfg = snap.Config;
            int focus = Math.Max(0, Math.Min(cfg.Entrants.Count - 1, playerSlot >= 0 ? playerSlot : spec.Camera.FocusSlot));
            var c = new ShareCard
            {
                Kind = Kind, Runners = cfg.Entrants.Count,
                HorseName = cfg.Entrants[focus].Horse?.Name ?? "",
                CourseName = string.IsNullOrEmpty(courseName) ? ShareCard.CourseLabel(cfg.Track) : courseName,
                ModeLabel = ShareCard.ModeText(cfg.Mode),
            };
            var caption = PhotoCaption.Normalize(spec.Caption);
            var o = new PhotoOverlay
            {
                LookAsset = AssetKeys.PhotoLook(spec.LookId ?? "natural"), FrameAsset = spec.FrameId != null ? AssetKeys.PhotoFrame(spec.FrameId) : null,
                Caption = caption, Dof = spec.Camera.Dof, HideUi = spec.HideUi,
                Plates = PhotoNames.Plates(cfg, playerSlot, friendNames, spec.Names),
            };
            foreach (var s in spec.Stamps) { o.Stamps.Add(s); o.StampAssets.Add(AssetKeys.PhotoStamp(s.Id)); }
            c.Photo = o;
            c.ShareText = c.HorseName + "　" + c.CourseName + (caption != null ? "　" + caption : "") + "　" + ShareCard.Hashtag;
            return c;
        }
    }
}
