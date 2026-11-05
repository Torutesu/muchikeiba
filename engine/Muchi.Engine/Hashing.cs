using System.Security.Cryptography;
using System.Text;

namespace Muchi.Engine
{
    /// <summary>FNV-1a 64-bit state checksum (contracts/protocol.md §5, REQ-RACE-070).</summary>
    public struct Fnv1a64
    {
        public const ulong OffsetBasis = 0xcbf29ce484222325UL;
        public const ulong Prime = 0x100000001b3UL;

        private ulong _h;

        public static Fnv1a64 Create() { var f = new Fnv1a64(); f._h = OffsetBasis; return f; }

        public void AddByte(byte b)
        {
            unchecked { _h = (_h ^ b) * Prime; }
        }

        /// <summary>Appends a little-endian int64.</summary>
        public void AddInt64(long v)
        {
            ulong u = unchecked((ulong)v);
            for (int i = 0; i < 8; i++) AddByte((byte)(u >> (8 * i)));
        }

        public ulong Value => _h;

        public string Hex => _h.ToString("x16");
    }

    public static class ResultHasher
    {
        /// <summary>Lowercase hex SHA-256 of the UTF-8 string (contracts/protocol.md §6).</summary>
        public static string Sha256Hex(string s)
        {
            using (var sha = SHA256.Create())
            {
                byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(s));
                var sb = new StringBuilder(64);
                foreach (var b in h) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }
    }
}
