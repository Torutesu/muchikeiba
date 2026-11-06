using System;
using Muchi.Engine;

namespace Muchi.Client
{
    public enum RaceCameraMode
    {
        /// <summary>Behind and a little outside the partner (06 §6.3: 6.5 m back, 3 m up).</summary>
        Follow = 0,
        /// <summary>Home straight, last 400 m: lower and closer.</summary>
        FinalStraight = 1,
        /// <summary>Side-on at the finish line, looking at the partner.</summary>
        Finish = 2,
    }

    /// <summary>A camera placement in course space (TrackGeometry coordinates; heights in metres above the turf).</summary>
    public struct RaceCameraShot
    {
        public RaceCameraMode Mode;
        public TrackPose Position;
        public float Height;
        public TrackPose LookAt;
        public float LookAtHeight;
        /// <summary>Vertical field of view, degrees.</summary>
        public float FieldOfViewDegrees;
        /// <summary>0..1000: how far the Follow → FinalStraight transition has gone (for smooth blending).</summary>
        public int StraightBlendPermille;
        public override string ToString() => Mode + " pos " + Position + " h" + Height.ToString("0.##") + " → " + LookAt;
    }

    /// <summary>
    /// RENDER-ONLY camera helper that keeps the player's horse in frame (06 §6.3, REQ-UXU-008): a follow shot
    /// behind the horse along the course (so it bends with the corners), a lower and closer shot on the home
    /// straight, and a side-on shot at the finish. Built on <see cref="TrackGeometry"/>, so it uses floating point
    /// and never feeds back into the simulation. Unity places the result with the same transform as the horses
    /// (Muchi.Game.CourseFrame.ToWorld).
    /// </summary>
    public sealed class RaceCameraRig
    {
        public TrackGeometry Geometry { get; }
        public int LaneWidthMm { get; }
        /// <summary>Distance (along the rail) where the last straight starts; the course length if it ends in a corner.</summary>
        public double LastStraightStartM { get; }

        public double FollowBackM = 6.5, FollowUpM = 3.0, FollowOutsideM = 1.5;
        public double StraightBackM = 5.0, StraightUpM = 1.8, StraightOutsideM = 2.0;
        /// <summary>The low shot starts with this many metres left (and only on the last straight).</summary>
        public double FinalStraightFromM = 400;
        /// <summary>Metres over which Follow blends into FinalStraight.</summary>
        public double BlendM = 40;
        public double LookAheadM = 8, LookAtHeightM = 1.2;
        /// <summary>Side shot from this many metres before the line, and for <see cref="FinishHoldM"/> after it.</summary>
        public double FinishFromM = 25, FinishHoldM = 40;
        /// <summary>Side shot: how far outside the horse's line the camera stands, and how high.</summary>
        public double FinishSideM = 12, FinishUpM = 2.0;
        public float FieldOfViewDegrees = 50;

        public RaceCameraRig(TrackGeometry geometry, TrackSpec spec, int laneWidthMm)
        {
            Geometry = geometry ?? throw new ArgumentNullException(nameof(geometry));
            if (spec == null) throw new ArgumentNullException(nameof(spec));
            LaneWidthMm = laneWidthMm;
            double start = 0, lastStraight = spec.DistanceM;
            foreach (var s in spec.Segments)
            {
                if (s.Kind == SegmentKind.Straight) lastStraight = start;
                start += s.LengthM;
            }
            var last = spec.Segments.Count > 0 ? spec.Segments[spec.Segments.Count - 1] : null;
            LastStraightStartM = last != null && last.Kind == SegmentKind.Straight ? lastStraight : spec.DistanceM;
        }

        public static RaceCameraRig For(RaceConfig config, TrackVisual visual = null)
            => new RaceCameraRig(TrackGeometry.For(config, visual), config.Track, config.Ruleset.LaneWidthMm);

        /// <summary>Shot for a horse at <paramref name="distanceM"/> along the rail and <paramref name="lateralM"/> outwards.</summary>
        public RaceCameraShot ShotAt(double distanceM, double lateralM)
        {
            double length = Geometry.LengthM;
            double remaining = length - distanceM;
            var horse = Geometry.PoseAt(distanceM, lateralM);
            if (remaining <= FinishFromM && remaining >= -FinishHoldM)
            {
                return new RaceCameraShot
                {
                    Mode = RaceCameraMode.Finish,
                    Position = Geometry.PoseAt(length, lateralM + FinishSideM),
                    Height = (float)FinishUpM,
                    LookAt = horse,
                    LookAtHeight = (float)LookAtHeightM,
                    FieldOfViewDegrees = FieldOfViewDegrees,
                    StraightBlendPermille = 1000,
                };
            }
            int blend = 0;
            if (distanceM >= LastStraightStartM && remaining <= FinalStraightFromM)
            {
                double into = FinalStraightFromM - remaining;
                if (distanceM - LastStraightStartM < into) into = distanceM - LastStraightStartM;
                blend = BlendM <= 0 ? 1000 : (int)Math.Max(0, Math.Min(1000, into / BlendM * 1000));
            }
            double a = blend / 1000.0;
            double back = FollowBackM + (StraightBackM - FollowBackM) * a;
            double up = FollowUpM + (StraightUpM - FollowUpM) * a;
            double side = FollowOutsideM + (StraightOutsideM - FollowOutsideM) * a;
            return new RaceCameraShot
            {
                Mode = blend >= 1000 ? RaceCameraMode.FinalStraight : RaceCameraMode.Follow,
                Position = PoseAlong(distanceM - back, lateralM + side),
                Height = (float)up,
                LookAt = Geometry.PoseAt(distanceM + LookAheadM, lateralM),
                LookAtHeight = (float)LookAtHeightM,
                FieldOfViewDegrees = FieldOfViewDegrees,
                StraightBlendPermille = blend,
            };
        }

        /// <summary>Pose along the course, continuing straight back behind the start for negative distances (camera at the gate).</summary>
        public TrackPose PoseAlong(double distanceM, double lateralM)
        {
            if (distanceM >= 0) return Geometry.PoseAt(distanceM, lateralM);
            var p = Geometry.PoseAt(0, lateralM);
            double yaw = p.YawDegrees * Math.PI / 180;
            return new TrackPose { X = (float)(p.X + Math.Sin(yaw) * distanceM), Y = 0, Z = (float)(p.Z + Math.Cos(yaw) * distanceM), YawDegrees = p.YawDegrees };
        }

        /// <summary>Shot for a horse between two engine states (alpha from the driver's interpolation).</summary>
        public RaceCameraShot Shot(HorseState from, HorseState to, int alphaPermille)
        {
            double a = Math.Max(0, Math.Min(1000, alphaPermille)) / 1000.0;
            double d = TrackGeometry.DistanceM(from.Distance) + (TrackGeometry.DistanceM(to.Distance) - TrackGeometry.DistanceM(from.Distance)) * a;
            double l = TrackGeometry.LateralM(from.Lane, LaneWidthMm) + (TrackGeometry.LateralM(to.Lane, LaneWidthMm) - TrackGeometry.LateralM(from.Lane, LaneWidthMm)) * a;
            return ShotAt(d, l);
        }

        /// <summary>
        /// Is a point (course space, at <paramref name="height"/>) inside the shot's view? Checks the horizontal
        /// and vertical angle from the look direction against the field of view for <paramref name="aspect"/>
        /// (width / height), shrunk by <paramref name="marginPermille"/> to keep it off the screen edge.
        /// </summary>
        public static bool InFrame(RaceCameraShot shot, TrackPose subject, double height, double aspect = 16.0 / 9.0, int marginPermille = 100)
        {
            double cx = shot.Position.X, cy = shot.Height, cz = shot.Position.Z;
            double lx = shot.LookAt.X - cx, ly = shot.LookAtHeight - cy, lz = shot.LookAt.Z - cz;
            double sx = subject.X - cx, sy = height - cy, sz = subject.Z - cz;
            double lh = Math.Sqrt(lx * lx + lz * lz), sh = Math.Sqrt(sx * sx + sz * sz);
            if (lh < 1e-6 || sh < 1e-6) return false;
            // horizontal angle between the two directions
            double cos = (lx * sx + lz * sz) / (lh * sh);
            double yaw = Math.Acos(Math.Max(-1, Math.Min(1, cos)));
            double pitch = Math.Abs(Math.Atan2(sy, sh) - Math.Atan2(ly, lh));
            double vHalf = shot.FieldOfViewDegrees * Math.PI / 360;
            double hHalf = Math.Atan(Math.Tan(vHalf) * aspect);
            double k = 1 - marginPermille / 1000.0;
            return yaw <= hHalf * k && pitch <= vHalf * k;
        }
    }
}
