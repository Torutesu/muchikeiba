using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-SILK-002/016: the silks code matches TS (contracts/silks-code.vectors.json) and the editor API (protocol §35).</summary>
    public class SilksCodeTests
    {
        private static JsonNode Vectors => JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "silks-code.vectors.json")));

        /// <summary>Part numbers from the same master the server uses (the client gets them from GET /v1/silks/editor).</summary>
        internal static SilksCodeTables MasterTables()
        {
            var e = JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "master", "silks-editor.json")));
            var v = JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "master", "visuals.json")));
            var counts = v.Get("silks").Get("patterns").Items.ToDictionary(p => p.Get("id").AsString(), p => p.Get("colors").AsInt());
            var t = new SilksCodeTables();
            foreach (var p in e.Get("patterns").Items) t.AddPattern(p.Get("id").AsString(), p.Get("code").AsInt(), counts[p.Get("id").AsString()]);
            foreach (var p in e.Get("colors").Items) t.AddColor(p.Get("id").AsString(), p.Get("code").AsInt());
            foreach (var p in e.Get("sleeves").Items) t.AddSleeve(p.Get("id").AsString(), p.Get("code").AsInt());
            foreach (var p in e.Get("caps").Items) t.AddCap(p.Get("id").AsString(), p.Get("code").AsInt());
            return t;
        }

        private static SilksDesign Design(JsonNode d) => new SilksDesign
        {
            Pattern = d.Get("pattern").AsString(), Colors = d.Get("colors").Items.Select(x => x.AsString()).ToArray(), Sleeve = d.Get("sleeve").AsString(),
            Cap = d.Get("cap").AsString(), CapColors = d.Get("capColors").Items.Select(x => x.AsString()).ToArray(),
        };

        [Fact]
        public void NumericVectorsMatchTypeScript()
        {
            foreach (var v in Vectors.Get("numeric").Items)
            {
                var n = v.Get("numbers").Items.Select(x => x.IsNull ? (int?)null : x.AsInt()).ToArray();
                Assert.Equal(v.Get("code").AsString(), SilksCode.Encode(n));
                Assert.Equal(n, SilksCode.Decode(v.Get("code").AsString()));
            }
        }

        [Fact]
        public void DesignAndLegacyVectorsMatchTypeScript()
        {
            var t = MasterTables();
            foreach (var v in Vectors.Get("designs").Items)
            {
                var d = Design(v.Get("design"));
                var code = v.Get("code").AsString();
                Assert.Equal(code, SilksCode.Encode(d, t));
                Assert.True(d.SameAs(SilksCode.Decode(code, t)), code);
            }
            foreach (var v in Vectors.Get("legacy").Items)
            {
                var s = new Silks { Pattern = v.Get("silks").Get("pattern").AsString(), Cap = v.Get("silks").Get("cap").AsString(), Colors = v.Get("silks").Get("colors").Items.Select(x => x.AsString()).ToArray() };
                Assert.True(Design(v.Get("design")).SameAs(SilksDesign.FromLegacy(s)));
                Assert.Equal(v.Get("code").AsString(), SilksCode.OfSilks(s, t));
            }
        }

        [Fact]
        public void InvalidCodesAreRejected()
        {
            foreach (var v in Vectors.Get("invalid").Items) Assert.Null(SilksCode.Decode(v.AsString()));
            Assert.Throws<System.ArgumentException>(() => SilksCode.Encode(new int?[] { 0, 0, 0, 0, null, 0, 0, 0 }));
            Assert.Throws<System.ArgumentException>(() => SilksCode.Encode(new int?[] { 1295, 0, 0, null, 0, 0, 0, 0 }));
            var t = MasterTables();
            Assert.Null(SilksCode.Decode("1yy0a00zz00000a00", t)); // unknown pattern number
            Assert.Null(SilksCode.Decode("1090a00zz00000a00", t)); // stars needs a third colour
        }

        [Fact]
        public void ServerCodeWinsOverLegacyKeys()
        {
            var t = MasterTables();
            var s = new Silks { Pattern = "hoops", Colors = new[] { "red", "white" }, Cap = "plain", Code = "1010a00zz06000a00", Sleeve = "stars", CapColors = new[] { "navy", "white" } };
            Assert.Equal("1010a00zz06000a00", SilksCode.OfSilks(s, t));
            Assert.Equal("stars", SilksCode.Decode(s.Code, t).Sleeve);
        }
    }

    public class ApiClientSilksEditorTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientSilksEditorTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        internal const string Editor = "{\"version\":1,\"codeVersion\":1,\"notice\":\"見た目のみ。\",\"contrast\":{\"minDeltaE\":20},\"lowContrastPairs\":[[\"white\",\"platinum\"]],"
            + "\"parts\":{\"patterns\":[{\"id\":\"hoops\",\"code\":1,\"name\":\"輪\",\"colors\":2,\"asset\":\"silks/pattern/hoops\",\"owned\":true,\"source\":{\"kind\":\"free\"},\"sourceLabel\":\"最初から使える\"}],"
            + "\"colors\":[{\"id\":\"white\",\"code\":0,\"name\":\"白\",\"hex\":\"#F5F5F2\",\"base\":\"white\",\"owned\":true,\"source\":{\"kind\":\"free\"},\"sourceLabel\":\"最初から使える\"},"
            + "{\"id\":\"navy\",\"code\":10,\"name\":\"紺\",\"hex\":\"#1F2F5C\",\"base\":\"navy\",\"owned\":true,\"source\":{\"kind\":\"free\"},\"sourceLabel\":\"最初から使える\"},"
            + "{\"id\":\"platinum\",\"code\":18,\"name\":\"プラチナ\",\"hex\":\"#E5E4E2\",\"base\":\"silver\",\"owned\":false,\"source\":{\"kind\":\"item\",\"itemId\":\"silkpart_color_platinum\"},\"sourceLabel\":\"有償コイン400で購入\","
            + "\"shop\":{\"itemId\":\"silkpart_color_platinum\",\"price\":400,\"currency\":\"paidOnly\",\"forSale\":true}}],"
            + "\"sleeves\":[{\"id\":\"match\",\"code\":0,\"name\":\"胴と同じ\",\"asset\":\"silks/sleeve/match\",\"owned\":true,\"source\":{\"kind\":\"free\"},\"sourceLabel\":\"最初から使える\"}],"
            + "\"caps\":[{\"id\":\"plain\",\"code\":0,\"name\":\"無地\",\"asset\":\"silks/cap/plain\",\"owned\":true,\"source\":{\"kind\":\"free\"},\"sourceLabel\":\"最初から使える\"}]},"
            + "\"current\":{\"design\":{\"pattern\":\"hoops\",\"colors\":[\"navy\",\"white\"],\"sleeve\":\"match\",\"cap\":\"plain\",\"capColors\":[\"navy\",\"white\"]},\"code\":\"1010a00zz00000a00\","
            + "\"silks\":{\"pattern\":\"hoops\",\"colors\":[\"navy\",\"white\"],\"cap\":\"plain\",\"sleeve\":\"match\",\"capColors\":[\"navy\",\"white\"],\"code\":\"1010a00zz00000a00\"},"
            + "\"resetNotice\":{\"at\":1,\"reason\":\"refund\",\"message\":\"返金によりパーツが取り消されたため、勝負服を初期の柄に戻しました\"}},"
            + "\"presets\":[{\"slot\":0,\"name\":\"本番用\",\"code\":\"1010a00zz06000a00\",\"design\":{\"pattern\":\"hoops\",\"colors\":[\"navy\",\"white\"],\"sleeve\":\"stars\",\"cap\":\"plain\",\"capColors\":[\"navy\",\"white\"]},"
            + "\"savedAt\":5,\"usable\":false,\"missing\":[{\"type\":\"sleeve\",\"id\":\"stars\",\"name\":\"星\",\"sourceLabel\":\"コイン200で購入\",\"shop\":{\"itemId\":\"silkpart_sleeve_stars\",\"price\":200,\"currency\":\"any\",\"forSale\":true}}]}],"
            + "\"maxPresets\":5,\"presetNameMax\":12,\"wallet\":{\"free\":120,\"paid\":30}}";

        [Fact]
        public async Task EditorViewParses()
        {
            _http.Reply(200, Editor);
            var v = await _api.GetSilksEditorAsync();
            var r = Assert.Single(_http.Requests);
            Assert.Equal("GET", r.Method);
            Assert.Equal("/v1/silks/editor", r.Path);
            Assert.Equal(20, v.MinDeltaE);
            Assert.True(v.IsLowContrast("platinum", "white"));
            var pt = v.Part("color", "platinum");
            Assert.False(pt.Owned);
            Assert.True(pt.Shop.PaidOnly);
            Assert.Equal(400, pt.Shop.Price);
            Assert.Equal("item", pt.SourceKind);
            Assert.Equal("1010a00zz00000a00", v.CurrentCode);
            Assert.Equal("1010a00zz00000a00", v.CurrentSilks.Code);
            Assert.NotNull(v.ResetNotice);
            var p = Assert.Single(v.Presets);
            Assert.False(p.Usable);
            Assert.Equal("stars", p.Missing[0].Id);
            Assert.Equal(30, v.Wallet.Paid);
            var t = SilksCodeTables.From(v);
            Assert.Equal(v.CurrentCode, SilksCode.Encode(v.Current, t));
        }

        [Fact]
        public async Task WritesSendTheDesignAndKeyThePurchase()
        {
            var d = new SilksDesign { Pattern = "hoops", Colors = new[] { "navy", "white" }, Sleeve = "match", Cap = "plain", CapColors = new[] { "navy", "white" } };
            _http.Reply(200, "{\"design\":{\"pattern\":\"hoops\",\"colors\":[\"navy\",\"white\"],\"sleeve\":\"match\",\"cap\":\"plain\",\"capColors\":[\"navy\",\"white\"]},\"code\":\"1010a00zz00000a00\",\"silks\":{\"pattern\":\"hoops\",\"colors\":[\"navy\",\"white\"],\"cap\":\"plain\"}}");
            var saved = await _api.SaveSilksAsync(d);
            Assert.Equal("1010a00zz00000a00", saved.Code);
            var r = _http.Requests[0];
            Assert.Equal("PUT", r.Method);
            Assert.Equal("/v1/silks", r.Path);
            Assert.Equal(JsonNode.Parse("{\"design\":{\"pattern\":\"hoops\",\"colors\":[\"navy\",\"white\"],\"sleeve\":\"match\",\"cap\":\"plain\",\"capColors\":[\"navy\",\"white\"]}}").ToString(), JsonNode.Parse(r.Body).ToString());

            _http.Reply(200, "{\"design\":{\"pattern\":\"hoops\",\"colors\":[\"navy\",\"white\"],\"sleeve\":\"match\",\"cap\":\"plain\",\"capColors\":[\"navy\",\"white\"]},\"code\":\"1010a00zz00000a00\",\"owned\":false,\"savable\":false,"
                + "\"locked\":[{\"type\":\"color\",\"id\":\"platinum\",\"name\":\"プラチナ\",\"sourceLabel\":\"有償コイン400で購入\",\"shop\":{\"itemId\":\"silkpart_color_platinum\",\"price\":400,\"currency\":\"paidOnly\",\"forSale\":true}}],"
                + "\"totalPrice\":{\"any\":0,\"paidOnly\":400},\"problems\":[{\"problem\":\"LOW_CONTRAST\",\"message\":\"色が近すぎて見分けにくい組み合わせです\"}]}");
            var pv = await _api.PreviewSilksAsync(d);
            Assert.False(pv.Savable);
            Assert.Equal(400, pv.TotalPaidOnly);
            Assert.Equal("LOW_CONTRAST", pv.Problems[0].Key);
            Assert.Equal("/v1/silks/preview", _http.Requests[1].Path);

            _http.Reply(200, "{\"slot\":0,\"presets\":[{\"slot\":0,\"name\":\"雨の日\",\"code\":\"1010a00zz00000a00\",\"design\":null,\"savedAt\":1,\"usable\":true,\"missing\":[]}]}");
            var ps = await _api.SaveSilksPresetAsync(d, "雨の日");
            Assert.Equal(0, ps.Slot);
            Assert.Equal("雨の日", JsonNode.Parse(_http.Requests[2].Body).Get("name").AsString());

            _http.Reply(200, "{\"presets\":[]}");
            await _api.DeleteSilksPresetAsync(0);
            Assert.Equal("DELETE", _http.Requests[3].Method);
            Assert.Equal("/v1/silks/presets/0", _http.Requests[3].Path);

            _http.Reply(200, "{\"itemId\":\"silkpart_sleeve_stars\",\"spent\":{\"paid\":50,\"free\":150},\"wallet\":{\"paid\":0,\"free\":10,\"total\":10,\"debt\":0},\"part\":{\"type\":\"sleeve\",\"id\":\"stars\",\"owned\":true}}");
            var b = await _api.BuySilksPartAsync("silkpart_sleeve_stars", "c:k1");
            Assert.Equal(50, b.SpentPaid);
            Assert.Equal(150, b.SpentFree);
            Assert.Equal("stars", b.PartId);
            Assert.Equal("/v1/silks/parts/silkpart_sleeve_stars/buy", _http.Requests[4].Path);
            Assert.Equal("c:k1", _http.Requests[4].Headers["idempotency-key"]);
        }
    }
}
