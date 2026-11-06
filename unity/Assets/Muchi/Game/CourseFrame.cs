using System;
using System.Collections.Generic;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    /// <summary>A pose in the race world (Unity metres, Y up, yaw clockwise from +Z like TrackPose).</summary>
    public struct WorldPose
    {
        public double X, Z, YawDegrees;
        public override string ToString() => "(" + X.ToString("0.###") + ", " + Z.ToString("0.###") + ") yaw " + YawDegrees.ToString("0.###");
    }

    /// <summary>A camera placement in the race world (RaceCameraRig's shot after CourseFrame.ToWorld).</summary>
    public struct WorldCameraShot
    {
        public RaceCameraMode Mode;
        public WorldPose Position;
        /// <summary>Camera height (world Y), metres.</summary>
        public double Height;
        public WorldPose LookAt;
        public double LookAtHeight;
        public double FieldOfViewDegrees;
        public int StraightBlendPermille;
    }

    /// <summary>
    /// Places the engine's course (TrackGeometry: distance along the inside rail + lateral offset) in the
    /// Unity race world so the finish line sits at (0, 0, FinishZ) facing +Z — where the race world's
    /// grandstand and finish beam are. Render-only maths (doubles), never fed back into the simulation.
    /// </summary>
    public sealed class CourseFrame
    {
        public const double DefaultFinishZ = 420;

        public TrackGeometry Geometry { get; }
        public double FinishZ { get; }
        public int LaneCount { get; }
        public int LaneWidthMm { get; }
        public bool LeftHanded => Geometry.LeftHanded;
        /// <summary>Lateral offset (m, towards the outside) of the outside rail.</summary>
        public double OuterRailM => LaneCount * LaneWidthMm / 1000.0 + 0.8;
        /// <summary>Lateral offset of the inside rail (slightly inside lane 0).</summary>
        public const double InnerRailM = -0.8;
        /// <summary>World x of the outside of the home straight (+1 = right of the finish line facing +Z).</summary>
        public double OutsideSign => LeftHanded ? 1 : -1;

        private readonly double _fx, _fz, _cos, _sin, _fyaw;

        public CourseFrame(TrackGeometry geometry, RulesetParams ruleset, double finishZ = DefaultFinishZ)
        {
            Geometry = geometry ?? throw new ArgumentNullException(nameof(geometry));
            LaneCount = ruleset?.LaneCount ?? 12;
            LaneWidthMm = ruleset?.LaneWidthMm ?? 1200;
            FinishZ = finishZ;
            var f = geometry.FinishPose();
            _fx = f.X; _fz = f.Z; _fyaw = f.YawDegrees;
            double t = _fyaw * Math.PI / 180;
            _cos = Math.Cos(t); _sin = Math.Sin(t);
        }

        public static CourseFrame For(RaceConfig config, RaceVisuals visuals, double finishZ = DefaultFinishZ)
            => new CourseFrame(TrackGeometry.For(config, visuals?.Track), config.Ruleset, finishZ);

        /// <summary>Course pose → world pose (rotate about the finish point by -finishYaw, then shift to FinishZ).</summary>
        public WorldPose ToWorld(TrackPose p)
        {
            double dx = p.X - _fx, dz = p.Z - _fz;
            // rotate by -θ in the clockwise-yaw convention: (x cosθ - z sinθ, x sinθ + z cosθ)
            double x = dx * _cos - dz * _sin;
            double z = dx * _sin + dz * _cos;
            double yaw = (p.YawDegrees - _fyaw) % 360;
            if (yaw < 0) yaw += 360;
            return new WorldPose { X = x, Z = z + FinishZ, YawDegrees = yaw };
        }

        public WorldPose At(double distanceM, double lateralM) => ToWorld(Geometry.PoseAt(distanceM, lateralM));

        /// <summary>Camera shot (course space) → world: same transform as the horses, heights unchanged.</summary>
        public WorldCameraShot ToWorld(RaceCameraShot shot) => new WorldCameraShot
        {
            Mode = shot.Mode,
            Position = ToWorld(shot.Position),
            Height = shot.Height,
            LookAt = ToWorld(shot.LookAt),
            LookAtHeight = shot.LookAtHeight,
            FieldOfViewDegrees = shot.FieldOfViewDegrees,
            StraightBlendPermille = shot.StraightBlendPermille,
        };

        /// <summary>Interpolated world pose of a horse between two engine states.</summary>
        public WorldPose Horse(HorseState from, HorseState to, int alphaPermille)
            => ToWorld(Geometry.Interpolated(from, to, alphaPermille, LaneWidthMm));

        /// <summary>Points along a lateral line (rails, turf edges) from the start to a little past the finish.</summary>
        public List<WorldPose> Line(double lateralM, double stepM, double runOutM = 40)
        {
            var list = new List<WorldPose>();
            foreach (var p in Geometry.Polyline(stepM, lateralM, 0, Geometry.LengthM + runOutM)) list.Add(ToWorld(p));
            return list;
        }

        /// <summary>Axis-aligned bounds (minX, minZ, maxX, maxZ) of the course including its rails.</summary>
        public (double minX, double minZ, double maxX, double maxZ) Bounds(double stepM = 20)
        {
            double minX = double.MaxValue, minZ = double.MaxValue, maxX = double.MinValue, maxZ = double.MinValue;
            foreach (var lat in new[] { InnerRailM, OuterRailM })
                foreach (var p in Line(lat, stepM))
                {
                    minX = Math.Min(minX, p.X); maxX = Math.Max(maxX, p.X);
                    minZ = Math.Min(minZ, p.Z); maxZ = Math.Max(maxZ, p.Z);
                }
            return (minX, minZ, maxX, maxZ);
        }
    }
}
