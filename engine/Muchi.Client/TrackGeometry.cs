using System;
using System.Collections.Generic;
using Muchi.Engine;

namespace Muchi.Client
{
    /// <summary>Position + heading on the course in Unity space (Y up, +Z forward at the start, yaw clockwise from +Z).</summary>
    public struct TrackPose
    {
        public float X, Y, Z;
        /// <summary>Heading in degrees, clockwise seen from above (Unity Quaternion.Euler(0, YawDegrees, 0)).</summary>
        public float YawDegrees;
        public override string ToString() => $"({X:0.###}, {Y:0.###}, {Z:0.###}) yaw {YawDegrees:0.###}";
    }

    /// <summary>
    /// RENDER-ONLY course geometry (contracts/assets.md §5). Maps the engine's 1-D course (distance along the
    /// inside rail + lateral lane offset) to a 3-D centreline. Uses floating point and is NOT deterministic
    /// across platforms — never feed its output back into the simulation (Muchi.Engine/Muchi.Net stay float-free;
    /// only Muchi.Client may use floats, and only for display like this).
    ///
    /// Rules (same as RaceSim, REQ-RACE-043):
    /// - Distance is measured along the inside rail (lane 0). Lane offset is perpendicular, towards the outside.
    /// - A corner of length L and radius R turns by L/R radians around a centre R metres inside the rail; a horse
    ///   at lateral offset o runs on radius R+o at the same angle (so it covers more ground per metre of progress).
    /// - Left-handed courses (left) turn left and have the outside on the right; right-handed mirror that.
    /// - No banking (Y = 0). Past the last segment the course continues straight (run-out after the finish).
    /// </summary>
    public sealed class TrackGeometry
    {
        private readonly struct Seg
        {
            public readonly double Start, Length, Radius; // radius 0 = straight
            public readonly double X, Z, Yaw;             // rail point + heading (radians) at the segment start
            public Seg(double start, double length, double radius, double x, double z, double yaw) { Start = start; Length = length; Radius = radius; X = x; Z = z; Yaw = yaw; }
        }

        private readonly List<Seg> _segs = new List<Seg>();
        private readonly double _sigma; // +1: outside to the right (left-handed course); -1: right-handed
        public bool LeftHanded { get; }
        /// <summary>Course length along the inside rail (= TrackSpec.DistanceM).</summary>
        public double LengthM { get; }

        public TrackGeometry(TrackSpec spec, bool leftHanded = true, double originX = 0, double originZ = 0, double startYawDegrees = 0)
        {
            if (spec == null) throw new ArgumentNullException(nameof(spec));
            LeftHanded = leftHanded;
            _sigma = leftHanded ? 1 : -1;
            double x = originX, z = originZ, yaw = startYawDegrees * Math.PI / 180, start = 0;
            foreach (var s in spec.Segments)
            {
                double r = s.Kind == SegmentKind.Corner ? s.RadiusM : 0;
                _segs.Add(new Seg(start, s.LengthM, r, x, z, yaw));
                var end = Advance(x, z, yaw, r, s.LengthM, 0);
                x = end.x; z = end.z; yaw = end.yaw;
                start += s.LengthM;
            }
            LengthM = start;
            _segs.Add(new Seg(start, double.PositiveInfinity, 0, x, z, yaw)); // run-out straight
        }

        /// <summary>Geometry of a race: direction from the server's track visual (default left-handed).</summary>
        public static TrackGeometry For(RaceConfig config, TrackVisual visual = null) => new TrackGeometry(config.Track, visual == null || visual.LeftHanded);

        private static double Sin(double a) => Math.Sin(a);
        private static double Cos(double a) => Math.Cos(a);

        // forward(yaw) = (sin, cos); right(yaw) = (cos, -sin) in (x, z)
        private (double x, double z, double yaw) Advance(double x, double z, double yaw, double r, double s, double lateral)
        {
            double ox = _sigma * Cos(yaw), oz = -_sigma * Sin(yaw); // outward unit vector at the segment start
            if (r <= 0)
                return (x + Sin(yaw) * s + ox * lateral, z + Cos(yaw) * s + oz * lateral, yaw);
            double cx = x - ox * r, cz = z - oz * r;                 // corner centre, r inside the rail
            double yaw2 = yaw - _sigma * (s / r);                     // turn towards the inside
            double ox2 = _sigma * Cos(yaw2), oz2 = -_sigma * Sin(yaw2);
            return (cx + ox2 * (r + lateral), cz + oz2 * (r + lateral), yaw2);
        }

        /// <summary>Pose at `distanceM` along the inside rail and `lateralM` towards the outside.</summary>
        public TrackPose PoseAt(double distanceM, double lateralM = 0)
        {
            if (distanceM < 0) distanceM = 0;
            int i = 0;
            while (i < _segs.Count - 1 && distanceM >= _segs[i + 1].Start) i++;
            var g = _segs[i];
            var p = Advance(g.X, g.Z, g.Yaw, g.Radius, distanceM - g.Start, lateralM);
            double deg = p.yaw * 180 / Math.PI % 360;
            if (deg < 0) deg += 360;
            return new TrackPose { X = (float)p.x, Y = 0, Z = (float)p.z, YawDegrees = (float)deg };
        }

        /// <summary>Lateral offset in metres of an engine lane (Fx lanes × laneWidthMm).</summary>
        public static double LateralM(Fx lane, int laneWidthMm) => lane.Raw / 65536.0 * laneWidthMm / 1000.0;
        public static double DistanceM(Fx distance) => distance.Raw / 65536.0;

        public TrackPose PoseOf(HorseState h, int laneWidthMm) => PoseAt(DistanceM(h.Distance), LateralM(h.Lane, laneWidthMm));

        /// <summary>Pose between two consecutive ticks (alpha from LockstepClient.InterpolationAlphaPermille).</summary>
        public TrackPose Interpolated(HorseState prev, HorseState cur, int alphaPermille, int laneWidthMm)
        {
            double a = Math.Max(0, Math.Min(1000, alphaPermille)) / 1000.0;
            double d = DistanceM(prev.Distance) + (DistanceM(cur.Distance) - DistanceM(prev.Distance)) * a;
            double l = LateralM(prev.Lane, laneWidthMm) + (LateralM(cur.Lane, laneWidthMm) - LateralM(prev.Lane, laneWidthMm)) * a;
            return PoseAt(d, l);
        }

        /// <summary>Points along the course every `stepM` (rail, rail fence, lane lines, camera rails…), including the finish.</summary>
        public List<TrackPose> Polyline(double stepM, double lateralM = 0, double fromM = 0, double toM = double.NaN)
        {
            if (stepM <= 0) throw new ArgumentOutOfRangeException(nameof(stepM));
            if (double.IsNaN(toM)) toM = LengthM;
            var list = new List<TrackPose>();
            for (double d = fromM; d < toM; d += stepM) list.Add(PoseAt(d, lateralM));
            list.Add(PoseAt(toM, lateralM));
            return list;
        }

        public TrackPose StartPose(double lateralM = 0) => PoseAt(0, lateralM);
        public TrackPose FinishPose(double lateralM = 0) => PoseAt(LengthM, lateralM);
    }
}
