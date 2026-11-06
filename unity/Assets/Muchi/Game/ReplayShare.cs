using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    // Replay share (docs/planning/06 §7 item 12 / §7.3, REQ-UXS-070..072, REQ-UXU-030). The race is re-simulated on the
    // device (Muchi.Client.ReplayClip), posed frame by frame through the same CourseFrame transform as the live race, and
    // handed to the recorder. Recording, encoding, the overlay art and the OS share sheet are Codex's (IClipRecorder,
    // IShareSheet; see docs/handoff-codex-round8.md "Round 9"). Nothing here touches UnityEngine.

    /// <summary>
    /// Captures the posed scene into a video (or one still) for sharing. Implemented in Unity (Codex): a RenderTexture at
    /// the share size, the watermark / end card drawn from <see cref="ShareCard"/>, H.264 encoding, files under
    /// Application.temporaryCachePath. Called from the main thread; every method may be awaited.
    /// </summary>
    public interface IClipRecorder
    {
        /// <summary>False on devices that cannot encode video: the flow falls back to a still image.</summary>
        bool SupportsVideo { get; }
        /// <summary>Set up the render target and overlay for <paramref name="clip"/> (frame rate = clip.Options.FramesPerSecond).</summary>
        void Begin(ReplayClip clip, ShareCard card);
        /// <summary>The scene has been posed for <paramref name="frame"/>; grab it (GPU readback may complete asynchronously).</summary>
        Task CaptureFrameAsync(ReplayClipFrame frame, CancellationToken ct);
        /// <summary>Finish encoding and return the local file path of the video (mp4).</summary>
        Task<string> FinishAsync(CancellationToken ct);
        /// <summary>One image of the posed scene with the card on it (png path). Used when video is not supported.</summary>
        Task<string> CaptureStillAsync(ReplayClipFrame frame, ShareCard card, CancellationToken ct);
        /// <summary>Drop a recording in progress (error / cancel / screen closed). Must be safe to call at any time.</summary>
        void Cancel();
    }

    /// <summary>The OS share sheet (Unity: native share plugin). Returns true when the player shared (not cancelled).</summary>
    public interface IShareSheet
    {
        Task<bool> ShareAsync(string filePath, string text, CancellationToken ct);
    }

    /// <summary>World-space placement of one clip frame (same transform as RaceWorld.Present / RaceObserver.CameraShot).</summary>
    public sealed class PosedClipFrame
    {
        public ReplayClipFrame Frame;
        /// <summary>Per slot (index = slot).</summary>
        public WorldPose[] Horses;
        public bool[] WhipActive, SkillActive;
        public WorldCameraShot Camera;
    }

    public enum ShareOutcomeKind { Shared, Cancelled, Failed, Unavailable }

    public sealed class ShareOutcome
    {
        public ShareOutcomeKind Kind;
        /// <summary>replay_video or replay_image (the analytics kind).</summary>
        public string MediaKind;
        public string FilePath;
        public string Message;
    }

    /// <summary>
    /// Result screen 「共有」 (REQ-UXS-070..072): builds the clip and the share card from a finished race, poses the frames
    /// and runs the recorder → share sheet. Sends the `share` KPI only when the player actually shared.
    /// </summary>
    public sealed class ReplayShareModel
    {
        public const string TextUnavailable = "このレースは共有できません";
        public const string TextFailed = "動画を作れませんでした。もう一度お試しください";

        public ReplayClip Clip { get; }
        public ShareCard Card { get; }
        public CourseFrame Frame { get; }

        public ReplayShareModel(ReplayClip clip, ShareCard card, CourseFrame frame)
        {
            Clip = clip ?? throw new ArgumentNullException(nameof(clip));
            Card = card ?? throw new ArgumentNullException(nameof(card));
            Frame = frame ?? throw new ArgumentNullException(nameof(frame));
        }

        /// <summary>
        /// Can this race be shared? Only a finished race the player rode (not spectating), not void / failed, with the
        /// inputs the device simulated (offline: OfflineRace.AllInputs, online: the confirmed lockstep inputs).
        /// </summary>
        public static bool CanShare(IRaceDriver driver)
        {
            if (driver == null || !driver.Done || driver.Sim == null || !driver.Sim.IsFinished || driver.PlayerSlot < 0) return false;
            if (driver.Phase == RacePhase.Void || driver.Phase == RacePhase.Failed) return false;
            return driver is OfflineRaceDriver || driver is OnlineRaceDriver;
        }

        /// <summary>The inputs that reproduce the race the device showed.</summary>
        public static IList<InputRecord> InputsOf(IRaceDriver driver)
        {
            if (driver is OfflineRaceDriver o) return o.Race.AllInputs();
            if (driver is OnlineRaceDriver on) return on.Session.Client.ConfirmedInputs.ToList();
            return null;
        }

        /// <summary>
        /// Build from a finished race. The replay must reproduce the race's hash (the server's when the room confirmed it),
        /// else null: never share a race that differs from the one that was run. <paramref name="courseName"/> = the
        /// track's display name (server tracks.json); null shows 「芝2000m」.
        /// </summary>
        public static ReplayShareModel From(IRaceDriver driver, string courseName = null, ReplayClipOptions options = null)
        {
            if (!CanShare(driver)) return null;
            var inputs = InputsOf(driver);
            string expected = driver.Final?.Hash ?? driver.Sim.Result?.Hash;
            ReplayClip clip;
            try { clip = ReplayClip.Build(driver.Config, inputs, driver.PlayerSlot, options, driver.Visuals?.Track, expected); }
            catch (InvalidOperationException) { return null; }
            return new ReplayShareModel(clip, ShareCard.Build(clip, courseName), CourseFrame.For(driver.Config, driver.Visuals));
        }

        /// <summary>World placement of every horse and the camera for a frame (for the recorder's scene and for previews).</summary>
        public PosedClipFrame Pose(ReplayClipFrame f)
        {
            int n = f.To.Length;
            var p = new PosedClipFrame { Frame = f, Horses = new WorldPose[n], WhipActive = new bool[n], SkillActive = new bool[n], Camera = Frame.ToWorld(f.Camera) };
            for (int s = 0; s < n; s++)
            {
                p.Horses[s] = Frame.Horse(f.From[s], f.To[s], f.AlphaPermille);
                p.WhipActive[s] = f.To[s].IsWhipActive;
                p.SkillActive[s] = f.To[s].IsSkillActive;
            }
            return p;
        }

        /// <summary>The frame for a still image: the focus horse crossing the line (or the last frame of a DNF).</summary>
        public ReplayClipFrame StillFrame() => Clip.FrameAt(Clip.FinishAtMs >= 0 ? Clip.FinishAtMs : Clip.DurationMs);

        /// <summary>
        /// Record the clip (or a still) and open the share sheet. <paramref name="applyPose"/> places the Unity scene
        /// (horses, camera) for each frame before the recorder captures it. Sends `share` (REQ-UXS-072) when shared.
        /// </summary>
        public async Task<ShareOutcome> RecordAndShareAsync(IClipRecorder recorder, IShareSheet sheet, Action<PosedClipFrame> applyPose,
            AnalyticsClient analytics = null, Func<long> clock = null, CancellationToken ct = default)
        {
            if (recorder == null) throw new ArgumentNullException(nameof(recorder));
            if (sheet == null) throw new ArgumentNullException(nameof(sheet));
            bool video = recorder.SupportsVideo;
            string kind = video ? "replay_video" : "replay_image";
            Card.Kind = kind;
            string path;
            try
            {
                if (video)
                {
                    recorder.Begin(Clip, Card);
                    foreach (var f in Clip.Frames())
                    {
                        ct.ThrowIfCancellationRequested();
                        applyPose?.Invoke(Pose(f));
                        await recorder.CaptureFrameAsync(f, ct);
                    }
                    path = await recorder.FinishAsync(ct);
                }
                else
                {
                    var still = StillFrame();
                    applyPose?.Invoke(Pose(still));
                    path = await recorder.CaptureStillAsync(still, Card, ct);
                }
            }
            catch (OperationCanceledException) { recorder.Cancel(); return new ShareOutcome { Kind = ShareOutcomeKind.Cancelled, MediaKind = kind }; }
            catch (Exception e) { recorder.Cancel(); return new ShareOutcome { Kind = ShareOutcomeKind.Failed, MediaKind = kind, Message = TextFailed + "（" + e.Message + "）" }; }
            if (string.IsNullOrEmpty(path)) return new ShareOutcome { Kind = ShareOutcomeKind.Failed, MediaKind = kind, Message = TextFailed };
            bool shared;
            try { shared = await sheet.ShareAsync(path, Card.ShareText, ct); }
            catch (OperationCanceledException) { shared = false; }
            if (!shared) return new ShareOutcome { Kind = ShareOutcomeKind.Cancelled, MediaKind = kind, FilePath = path };
            analytics?.Track(AnalyticsEvent.Share((clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))(), kind));
            return new ShareOutcome { Kind = ShareOutcomeKind.Shared, MediaKind = kind, FilePath = path };
        }
    }
}
