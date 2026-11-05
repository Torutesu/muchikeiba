namespace Muchi.Engine
{
    /// <summary>Precomputed 1-D track (REQ-RACE-004, REQ-RACE-082).</summary>
    public sealed class TrackLayout
    {
        public readonly TrackSpec Spec;
        public readonly Fx Distance;
        private readonly Fx[] _starts;
        private readonly Fx[] _ends;

        public TrackLayout(TrackSpec spec)
        {
            Spec = spec;
            Distance = Fx.FromInt(spec.DistanceM);
            int n = spec.Segments.Count;
            _starts = new Fx[n];
            _ends = new Fx[n];
            long acc = 0;
            for (int i = 0; i < n; i++)
            {
                _starts[i] = Fx.FromInt(acc);
                acc += spec.Segments[i].LengthM;
                _ends[i] = Fx.FromInt(acc);
            }
        }

        public int SegmentCount => _starts.Length;
        public TrackSegment Segment(int i) => Spec.Segments[i];
        public Fx SegmentStart(int i) => _starts[i];
        public Fx SegmentEnd(int i) => _ends[i];

        /// <summary>Index of the segment containing distance d (clamped to the last segment).</summary>
        public int SegmentIndexAt(Fx d)
        {
            for (int i = 0; i < _ends.Length; i++)
                if (d < _ends[i]) return i;
            return _ends.Length - 1;
        }
    }
}
