// Round 15: フォトモード (REQ-PHOTO-*, contracts/protocol.md §38) for the web prototype. The real PhotoModeModel of the
// Unity game layer over the race the WASM engine runs: pause a solo race (OfflineRace.Pause), PhotoSnapshot re-simulates
// it to the tick (never stepping the live race), PhotoCamera keeps the camera in the limits and above the course, the
// pose uses the same CourseFrame transform as the race, and PhotoShareCard builds the share card. The catalog / unlocks
// and the saved records come from the server logic in JS (logic/entry.ts), like the app gets them from the API.
using System;
using System.Runtime.InteropServices.JavaScript;
using System.Text;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

public static partial class MuchiRace
{
    private static PhotoModeModel _pm;

    /// <summary>
    /// kind: paused (the running race) | result (the finished race) | replay (the finished race at <paramref name="tick"/>, or at that
    /// clip time in ms when the replay share player is open).
    /// <paramref name="shared"/>: the race is run with other people (the JS knows: the prototype's ranked race) — never paused.
    /// </summary>
    [JSExport]
    public static string PhotoOpen(string kind, double nowMs, string raceId, bool shared, int tick)
    {
        _pm?.Close();
        _pm = null;
        if (_driver == null) return Fail("レースがありません");
        string live = null;
        if (kind == "paused")
        {
            if (shared || !PhotoModeModel.CanPause(_driver)) return Fail("このレースは走っている途中では撮れません。結果画面かリプレイから撮ってください。");
            live = _driver.Sim.ComputeChecksum();
            _pm = PhotoModeModel.OpenPaused(_driver, null, raceId, null, null, () => false, null, () => (long)nowMs);
        }
        else if (kind == "result") _pm = PhotoModeModel.OpenFromResult(_driver, null, raceId, null, null, () => false, null, () => (long)nowMs);
        else
        {
            if (!_driver.Done) return Fail("リプレイはレースの後に見られます");
            if (_share != null) tick = _share.Clip.FrameAt(tick).Tick; // from the replay share player: `tick` is the clip time (ms)
            string mode = shared ? "ranked" : PhotoSource.ModeOf(_driver.Config.Mode, false);
            _pm = PhotoModeModel.OpenFromReplay(_driver.Config, _driver.Race.AllInputs(), tick, _driver.PlayerSlot, mode, raceId, null, _driver.Visuals, null, null, () => false, null, () => (long)nowMs);
        }
        if (_pm == null) return Fail("このレースは撮れません");
        if (shared) _pm.Spec.Source.Mode = "ranked"; // the prototype's ranked race runs locally; the record says what it stands for
        var s = _pm.Snapshot;
        var sb = new StringBuilder("{\"ok\":true");
        sb.Append(",\"tick\":").Append(s.Tick).Append(",\"fingerprint\":\"").Append(s.Fingerprint).Append('"');
        if (live != null) sb.Append(",\"liveChecksum\":\"").Append(live).Append('"');
        sb.Append(",\"paused\":").Append(B(_driver.Race.IsPaused)).Append(",\"runners\":").Append(s.States.Length);
        var src = _pm.Spec.Source;
        sb.Append(",\"source\":{\"kind\":\"").Append(src.Kind).Append("\",\"mode\":\"").Append(src.Mode).Append("\",\"raceId\":\"").Append(Esc(src.RaceId)).Append("\",\"tick\":").Append(src.Tick).Append('}');
        sb.Append(",\"remainingM\":").Append((int)Math.Ceiling(Math.Max(0, s.Config.Track.DistanceM - TrackGeometry.DistanceM(s.States[_driver.PlayerSlot].Distance))));
        sb.Append(",\"camera\":").Append(CameraJson());
        return sb.Append('}').ToString();
    }

    /// <summary>op: orbit | zoom | raise | fov | dof | focus | reset (value = the step / level / slot).</summary>
    [JSExport]
    public static string PhotoCamera(string op, int value)
    {
        if (_pm == null) return "{}";
        switch (op)
        {
            case "orbit": _pm.Orbit(value); break;
            case "zoom": _pm.Zoom(value); break;
            case "raise": _pm.Raise(value); break;
            case "fov": _pm.Fov(value); break;
            case "dof": _pm.SetDof(value); break;
            case "focus": _pm.Focus(value); break;
            case "reset": _pm.ResetCamera(); break;
        }
        return CameraJson();
    }

    private static string CameraJson()
    {
        var c = _pm.Spec.Camera;
        var shot = _pm.Shot;
        return "{\"focusSlot\":" + c.FocusSlot + ",\"orbitDeg\":" + c.OrbitDeg + ",\"distanceDm\":" + c.DistanceDm + ",\"heightDm\":" + c.HeightDm + ",\"fovDeg\":" + c.FovDeg + ",\"dof\":" + c.Dof
            + ",\"heightM\":" + F(shot.Height) + ",\"inFrame\":" + B(RaceCameraRig.InFrame(shot, _pm.Snapshot.PoseOf(c.FocusSlot, _driver.Visuals?.Track), Muchi.Client.PhotoCamera.LookAtHeightM)) + "}";
    }

    /// <summary>The posed photo for the 3D view (same shape as ClipFrame: horses [x, z, yaw, rank, whip, visible, visible] and cam).</summary>
    [JSExport]
    public static string PhotoFrame()
    {
        if (_pm == null) return "{}";
        var p = _pm.Pose();
        var sb = new StringBuilder(1024);
        sb.Append("{\"t\":0,\"remainingM\":").Append(F(p.Frame.FocusRemainingM)).Append(",\"horses\":[");
        for (int i = 0; i < p.Horses.Length; i++)
        {
            if (i > 0) sb.Append(',');
            var h = p.Horses[i];
            sb.Append('[').Append(F(h.X + _xShift)).Append(',').Append(F(h.Z)).Append(',').Append(F(h.YawDegrees)).Append(',').Append(p.Frame.To[i].Rank).Append(",false,true,true]");
        }
        var c = p.Camera;
        sb.Append("],\"cam\":[").Append(F(c.Position.X + _xShift)).Append(',').Append(F(c.Height)).Append(',').Append(F(c.Position.Z)).Append(',')
          .Append(F(c.LookAt.X + _xShift)).Append(',').Append(F(c.LookAtHeight)).Append(',').Append(F(c.LookAt.Z)).Append(',').Append(F(c.FieldOfViewDegrees)).Append(",\"Photo\"]}");
        return sb.ToString();
    }

    /// <summary>A caption through PhotoCaption (null problem = accepted, normalised).</summary>
    [JSExport]
    public static string PhotoCaption(string text, int maxChars)
    {
        var problem = Muchi.Client.PhotoCaption.Problem(text, maxChars);
        return "{\"ok\":" + B(problem == null) + ",\"problem\":" + (problem == null ? "null" : "\"" + Esc(problem) + "\"") + ",\"caption\":" + (problem == null && Muchi.Client.PhotoCaption.Normalize(text) is string n ? "\"" + Esc(n) + "\"" : "null") + "}";
    }

    /// <summary>
    /// The share card (PhotoShareCard) for the overlays chosen in JS (the server catalog decides what is unlocked):
    /// stamps = "id:x:y,id:x:y". Returns the card, the plates and the spec the record would store.
    /// </summary>
    [JSExport]
    public static string PhotoCard(string lookId, string frameId, string stamps, string caption, string names)
    {
        if (_pm == null) return "{}";
        var spec = _pm.Spec;
        spec.LookId = string.IsNullOrEmpty(lookId) ? "natural" : lookId;
        spec.FrameId = string.IsNullOrEmpty(frameId) ? null : frameId;
        spec.Stamps.Clear();
        if (!string.IsNullOrEmpty(stamps))
            foreach (var part in stamps.Split(','))
            {
                var a = part.Split(':');
                spec.Stamps.Add(new PhotoStampPlacement { Id = a[0], XPermille = a.Length > 1 ? int.Parse(a[1]) : 500, YPermille = a.Length > 2 ? int.Parse(a[2]) : 500 });
            }
        spec.Caption = Muchi.Client.PhotoCaption.Normalize(caption);
        spec.Names = names == PhotoNameModes.Hidden ? PhotoNameModes.Hidden : PhotoNameModes.Masked;
        var card = _pm.Card();
        var sb = new StringBuilder("{\"kind\":\"").Append(card.Kind).Append("\",\"watermark\":\"").Append(Esc(card.Watermark)).Append("\",\"horse\":\"").Append(Esc(card.HorseName))
            .Append("\",\"course\":\"").Append(Esc(card.CourseName)).Append("\",\"mode\":\"").Append(Esc(card.ModeLabel)).Append("\",\"shareText\":\"").Append(Esc(card.ShareText))
            .Append("\",\"look\":\"").Append(card.Photo.LookAsset).Append("\",\"frame\":").Append(card.Photo.FrameAsset == null ? "null" : "\"" + card.Photo.FrameAsset + "\"").Append(",\"plates\":[");
        for (int i = 0; i < card.Photo.Plates.Count; i++)
        {
            var p = card.Photo.Plates[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"slot\":").Append(p.Slot).Append(",\"horse\":\"").Append(Esc(p.HorseName)).Append("\",\"rider\":\"").Append(Esc(p.Rider)).Append("\",\"you\":").Append(B(p.You)).Append('}');
        }
        var c = spec.Camera;
        sb.Append("],\"spec\":{\"source\":{\"kind\":\"").Append(spec.Source.Kind).Append("\",\"mode\":\"").Append(spec.Source.Mode).Append("\",\"raceId\":\"").Append(Esc(spec.Source.RaceId)).Append("\",\"tick\":").Append(spec.Source.Tick)
          .Append("},\"camera\":{\"focusSlot\":").Append(c.FocusSlot).Append(",\"orbitDeg\":").Append(c.OrbitDeg).Append(",\"distanceDm\":").Append(c.DistanceDm).Append(",\"heightDm\":").Append(c.HeightDm).Append(",\"fovDeg\":").Append(c.FovDeg).Append(",\"dof\":").Append(c.Dof)
          .Append("},\"lookId\":\"").Append(spec.LookId).Append("\",\"frameId\":").Append(spec.FrameId == null ? "null" : "\"" + spec.FrameId + "\"").Append(",\"stamps\":[");
        for (int i = 0; i < spec.Stamps.Count; i++)
        {
            var st = spec.Stamps[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"id\":\"").Append(st.Id).Append("\",\"xPermille\":").Append(st.XPermille).Append(",\"yPermille\":").Append(st.YPermille).Append(",\"scalePermille\":").Append(st.ScalePermille).Append(",\"rotDeg\":").Append(st.RotDeg).Append('}');
        }
        sb.Append("],\"caption\":").Append(spec.Caption == null ? "null" : "\"" + Esc(spec.Caption) + "\"").Append(",\"names\":\"").Append(spec.Names).Append("\",\"hideUi\":true}}");
        return sb.ToString();
    }

    /// <summary>Leave photo mode: a paused race resumes (its clock does not count the pause). Returns the race tick.</summary>
    [JSExport]
    public static int PhotoClose(double nowMs)
    {
        if (_driver != null && _driver.Race.IsPaused) _driver.Race.Resume((long)nowMs); // the real clock (the model's is the opening time)
        _pm?.Close();
        _pm = null;
        return _driver?.Sim?.Tick ?? -1;
    }

    private static string Fail(string message) => "{\"ok\":false,\"message\":\"" + Esc(message) + "\"}";
}
