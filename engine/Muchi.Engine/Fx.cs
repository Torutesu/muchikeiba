using System;

namespace Muchi.Engine
{
    /// <summary>
    /// Q16.16 fixed-point number stored in a 64-bit integer (REQ-RACE-001).
    /// Units are meters / seconds unless noted. No floating point anywhere.
    /// </summary>
    public readonly struct Fx : IEquatable<Fx>, IComparable<Fx>
    {
        public const int Shift = 16;
        public const long OneRaw = 1L << Shift;

        public readonly long Raw;

        private Fx(long raw) { Raw = raw; }

        public static readonly Fx Zero = new Fx(0);
        public static readonly Fx One = new Fx(OneRaw);

        public static Fx FromRaw(long raw) => new Fx(raw);
        public static Fx FromInt(long v) => new Fx(v << Shift);
        /// <summary>value / 1000 (e.g. millimeters to meters, permille to ratio).</summary>
        public static Fx FromMilli(long milli) => new Fx((milli << Shift) / 1000);
        public static Fx FromRatio(long num, long den) => new Fx((num << Shift) / den);

        public static Fx operator +(Fx a, Fx b) => new Fx(a.Raw + b.Raw);
        public static Fx operator -(Fx a, Fx b) => new Fx(a.Raw - b.Raw);
        public static Fx operator -(Fx a) => new Fx(-a.Raw);
        public static Fx operator *(Fx a, Fx b) => new Fx((a.Raw * b.Raw) >> Shift);
        public static Fx operator /(Fx a, Fx b) => new Fx((a.Raw << Shift) / b.Raw);
        public static Fx operator *(Fx a, long k) => new Fx(a.Raw * k);
        public static Fx operator /(Fx a, long k) => new Fx(a.Raw / k);

        /// <summary>a * permille / 1000</summary>
        public Fx MulPermille(long permille) => new Fx(Raw * permille / 1000);

        public static bool operator <(Fx a, Fx b) => a.Raw < b.Raw;
        public static bool operator >(Fx a, Fx b) => a.Raw > b.Raw;
        public static bool operator <=(Fx a, Fx b) => a.Raw <= b.Raw;
        public static bool operator >=(Fx a, Fx b) => a.Raw >= b.Raw;
        public static bool operator ==(Fx a, Fx b) => a.Raw == b.Raw;
        public static bool operator !=(Fx a, Fx b) => a.Raw != b.Raw;

        public static Fx Min(Fx a, Fx b) => a.Raw <= b.Raw ? a : b;
        public static Fx Max(Fx a, Fx b) => a.Raw >= b.Raw ? a : b;
        public static Fx Clamp(Fx v, Fx lo, Fx hi) => v.Raw < lo.Raw ? lo : (v.Raw > hi.Raw ? hi : v);
        public Fx Abs() => Raw < 0 ? new Fx(-Raw) : this;

        /// <summary>Integer part (floor).</summary>
        public long FloorToInt() => Raw >> Shift;
        /// <summary>Value * 1000 truncated toward zero (for display: mm, permille).</summary>
        public long ToMilli() => Raw * 1000 / OneRaw;

        public bool Equals(Fx other) => Raw == other.Raw;
        public override bool Equals(object obj) => obj is Fx f && f.Raw == Raw;
        public override int GetHashCode() => Raw.GetHashCode();
        public int CompareTo(Fx other) => Raw.CompareTo(other.Raw);
        public override string ToString()
        {
            long milli = ToMilli();
            string sign = milli < 0 ? "-" : "";
            long a = milli < 0 ? -milli : milli;
            return sign + (a / 1000) + "." + (a % 1000).ToString("D3");
        }
    }
}
