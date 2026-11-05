using System.IO;
using System.Linq;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// Muchi.Engine / Muchi.Net / Muchi.Client are Unity local packages (unity/Packages/manifest.json).
    /// These checks keep them importable: no dotnet build output inside the package folders, and the runtime
    /// data Unity loads from Resources stays identical to the source of truth.
    /// </summary>
    public class UnityPackageTests
    {
        private static readonly string[] Packages = { "Muchi.Engine", "Muchi.Net", "Muchi.Client" };

        [Fact]
        public void PackageFoldersContainNoBuildOutput()
        {
            foreach (var p in Packages)
            {
                string dir = Path.Combine(TestUtil.RepoRoot, "engine", p);
                Assert.True(File.Exists(Path.Combine(dir, "package.json")), p + " has no package.json");
                Assert.True(File.Exists(Path.Combine(dir, p + ".asmdef")), p + " has no asmdef");
                // Directory.Build.props redirects these to engine/.build; Unity would compile obj/*.cs and import bin/*.dll.
                Assert.False(Directory.Exists(Path.Combine(dir, "bin")), p + "/bin exists (Unity would import its DLLs)");
                Assert.False(Directory.Exists(Path.Combine(dir, "obj")), p + "/obj exists (Unity would compile its generated .cs)");
            }
        }

        [Fact]
        public void BundledRulesetMatchesContracts()
        {
            string bundled = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", "ruleset-params.default.json"));
            string source = File.ReadAllText(TestUtil.DefaultRulesetPath);
            Assert.True(Normalize(bundled) == Normalize(source),
                "engine/Muchi.Client/Resources/Muchi/ruleset-params.default.json is stale: run scripts/sync-unity-data.sh (copies contracts/ruleset-params.default.json)");
        }

        [Fact]
        public void CommentaryTemplatesLoadFromResources()
        {
            string json = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", "commentary-ja.json"));
            var t = Muchi.Client.CommentaryTemplates.Parse(json);
            Assert.True(t.Phrases.Count > 0);
        }

        private static string Normalize(string s) => string.Join("\n", s.Replace("\r\n", "\n").Split('\n').Select(l => l.TrimEnd())).Trim();
    }
}
