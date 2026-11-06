using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Muchi.Client
{
    /// <summary>
    /// On-disk asset cache (REQ-DLV-006), content-addressed so a file shared by several keys or kept across catalog
    /// versions is stored once:
    /// <code>
    /// &lt;root&gt;/blobs/&lt;sha[0..2]&gt;/&lt;sha256&gt;      verified, complete files (only ever created by an atomic rename)
    /// &lt;root&gt;/partial/&lt;sha256&gt;.part          downloads in progress (resumed with a Range request)
    /// &lt;root&gt;/catalog-&lt;platform&gt;.json         last good catalog (written to .tmp, then replaced)
    /// </code>
    /// Unity: root = Application.persistentDataPath + "/muchi-assets" (not temporaryCachePath: the OS may purge it).
    /// Blobs are never modified in place, so a reader (AssetBundle.LoadFromFile) never sees a half-written file.
    /// </summary>
    public sealed class AssetCache
    {
        private readonly Func<long> _availableBytes;

        public string Root { get; }

        /// <param name="availableBytes">Free bytes on the volume. Unity has no portable API: pass a native one; the default
        /// asks <see cref="DriveInfo"/> and reports "unknown" (long.MaxValue) when that fails.</param>
        public AssetCache(string root, Func<long> availableBytes = null)
        {
            if (string.IsNullOrEmpty(root)) throw new ArgumentException("root is required", nameof(root));
            Root = System.IO.Path.GetFullPath(root);
            _availableBytes = availableBytes;
            Directory.CreateDirectory(BlobDir);
            Directory.CreateDirectory(PartialDir);
        }

        private string BlobDir => System.IO.Path.Combine(Root, "blobs");
        private string PartialDir => System.IO.Path.Combine(Root, "partial");

        public string BlobPath(string sha256) => System.IO.Path.Combine(BlobDir, sha256.Substring(0, 2), sha256);
        public string PartPath(string sha256) => System.IO.Path.Combine(PartialDir, sha256 + ".part");

        /// <summary>Complete and verified (verification happens before the rename into blobs/; size guards truncation by the OS).</summary>
        public bool HasBlob(string sha256, long size)
        {
            var f = new FileInfo(BlobPath(sha256));
            return f.Exists && f.Length == size;
        }

        public long PartialLength(string sha256)
        {
            var f = new FileInfo(PartPath(sha256));
            return f.Exists ? f.Length : 0;
        }

        public long AvailableBytes()
        {
            if (_availableBytes != null) return _availableBytes();
            try { return new DriveInfo(System.IO.Path.GetPathRoot(Root)).AvailableFreeSpace; }
            catch (Exception) { return long.MaxValue; }
        }

        /// <summary>Bytes held by blobs and partial downloads.</summary>
        public long UsedBytes()
        {
            long n = 0;
            foreach (var f in Files(BlobDir)) n += f.Length;
            foreach (var f in Files(PartialDir)) n += f.Length;
            return n;
        }

        private static IEnumerable<FileInfo> Files(string dir)
        {
            var d = new DirectoryInfo(dir);
            if (!d.Exists) yield break;
            foreach (var f in d.EnumerateFiles("*", SearchOption.AllDirectories)) yield return f;
        }

        /// <summary>Opens the partial file: append from its current end, or truncated to 0.</summary>
        public FileStream OpenPart(string sha256, bool append)
            => new FileStream(PartPath(sha256), append ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None, 64 * 1024);

        /// <summary>SHA-256 of the partial file (lowercase hex), or null when it does not exist.</summary>
        public string HashPart(string sha256)
        {
            string p = PartPath(sha256);
            if (!File.Exists(p)) return null;
            using (var s = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024))
            using (var h = SHA256.Create())
                return Hex(h.ComputeHash(s));
        }

        /// <summary>Moves a verified partial file into blobs/ (atomic rename on the same volume).</summary>
        public void CommitPart(string sha256)
        {
            string dest = BlobPath(sha256);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(dest));
            string part = PartPath(sha256);
            if (File.Exists(dest))
            {
                // same length: the same verified content (blobs are only ever created verified). Another length: the
                // blob was truncated or damaged outside the app; replace it with the verified download (QA r9).
                if (new FileInfo(dest).Length == new FileInfo(part).Length || !TryDelete(dest)) { File.Delete(part); return; }
            }
            File.Move(part, dest);
        }

        public void DeletePart(string sha256) { TryDelete(PartPath(sha256)); }
        public void DeleteBlob(string sha256) { TryDelete(BlobPath(sha256)); }

        private static bool TryDelete(string p)
        {
            try { if (File.Exists(p)) { File.Delete(p); return true; } }
            catch (IOException) { /* in use (e.g. a loaded AssetBundle on Windows): try again next eviction */ }
            catch (UnauthorizedAccessException) { }
            return false;
        }

        /// <summary>
        /// Deletes every blob and partial download whose hash is not in <paramref name="keep"/> (older versions of re-made
        /// assets, keys removed from the catalog). Call it after a new catalog was accepted and before loading assets.
        /// </summary>
        public EvictionResult Evict(ISet<string> keep)
        {
            var r = new EvictionResult();
            foreach (var f in Files(BlobDir))
                if (!keep.Contains(f.Name)) { long len = f.Length; if (TryDelete(f.FullName)) { r.Files++; r.Bytes += len; } }
            foreach (var f in Files(PartialDir))
            {
                string sha = f.Name.EndsWith(".part", StringComparison.Ordinal) ? f.Name.Substring(0, f.Name.Length - 5) : f.Name;
                if (!keep.Contains(sha)) { long len = f.Length; if (TryDelete(f.FullName)) { r.Files++; r.Bytes += len; } }
            }
            return r;
        }

        // ------------------------------------------------------------------ catalog persistence

        public string CatalogPath(string platform) => System.IO.Path.Combine(Root, "catalog-" + platform + ".json");

        public string ReadCatalog(string platform)
        {
            try { string p = CatalogPath(platform); return File.Exists(p) ? File.ReadAllText(p, Encoding.UTF8) : null; }
            catch (IOException) { return null; }
        }

        public void WriteCatalog(string platform, string json) => WriteAllTextAtomic(CatalogPath(platform), json);

        /// <summary>Writes to "&lt;path&gt;.tmp", flushes, then replaces: a crash leaves either the old or the new file, never a mix.</summary>
        public static void WriteAllTextAtomic(string path, string text)
        {
            string tmp = path + ".tmp";
            using (var s = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var bytes = new UTF8Encoding(false).GetBytes(text);
                s.Write(bytes, 0, bytes.Length);
                s.Flush(true);
            }
            if (File.Exists(path))
            {
                try { File.Replace(tmp, path, null); return; }
                catch (PlatformNotSupportedException) { File.Delete(path); }
            }
            File.Move(tmp, path);
        }

        public static string Hex(byte[] b)
        {
            var sb = new StringBuilder(b.Length * 2);
            foreach (byte x in b) sb.Append(x.ToString("x2"));
            return sb.ToString();
        }
    }

    public sealed class EvictionResult
    {
        public int Files;
        public long Bytes;
    }
}
