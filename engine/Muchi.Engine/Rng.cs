namespace Muchi.Engine
{
    /// <summary>Deterministic PCG32 (XSH RR) random generator (REQ-RACE-002).</summary>
    public struct Pcg32
    {
        private ulong _state;
        private ulong _inc;

        public Pcg32(ulong seed, ulong stream)
        {
            _state = 0;
            _inc = (stream << 1) | 1UL;
            NextUInt();
            _state += seed;
            NextUInt();
        }

        public uint NextUInt()
        {
            ulong old = _state;
            _state = unchecked(old * 6364136223846793005UL + _inc);
            uint xorshifted = (uint)(((old >> 18) ^ old) >> 27);
            int rot = (int)(old >> 59);
            return (xorshifted >> rot) | (xorshifted << ((-rot) & 31));
        }

        /// <summary>Uniform-ish integer in [0, maxExclusive). maxExclusive must be &gt; 0.</summary>
        public int NextInt(int maxExclusive)
        {
            return (int)(((ulong)NextUInt() * (ulong)maxExclusive) >> 32);
        }

        /// <summary>Integer in [minInclusive, maxInclusive].</summary>
        public int Range(int minInclusive, int maxInclusive)
        {
            return minInclusive + NextInt(maxInclusive - minInclusive + 1);
        }

        /// <summary>True with probability num/den.</summary>
        public bool Chance(int num, int den)
        {
            return NextInt(den) < num;
        }
    }

    public static class SeedMix
    {
        /// <summary>SplitMix64 finalizer, used to derive independent per-slot seeds.</summary>
        public static ulong Mix(ulong x)
        {
            unchecked
            {
                x += 0x9E3779B97F4A7C15UL;
                x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9UL;
                x = (x ^ (x >> 27)) * 0x94D049BB133111EBUL;
                return x ^ (x >> 31);
            }
        }

        public static ulong Derive(ulong seed, ulong salt, ulong index)
        {
            return Mix(Mix(seed ^ Mix(salt)) + index);
        }
    }
}
