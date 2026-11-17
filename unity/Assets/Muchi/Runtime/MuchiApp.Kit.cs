using System;
using UnityEngine;
using UnityEngine.UI;

namespace Muchi.Client
{
    // The ムチ一閃 screen kit: the shared look of every screen built in code (the same tokens as the web prototype's
    // presentation tokens). New screens live in their own partial files (MuchiApp.<Area>.cs) and draw only with these
    // helpers plus Rect / Label / ArtImage from MuchiApp.cs, so screens built in parallel look like one game.
    //   - full-screen photoreal art (SetArt), sparse layout, 1600×900 reference canvas
    //   - translucent navy panels (Card)
    //   - small letter-spaced cyan section labels (Kicker)
    //   - one skewed cyan call to action with » (Cta); secondary actions are outlined (Ghost)
    //   - body text never below 16 px (BodyMin); gold only for rarity, rank and money
    //   - Moment: the shared claim / reveal overlay (light behind the picture, one line, one button)
    public sealed partial class MuchiApp
    {
        public const int BodyMin = 16;
        static readonly Color KitPanel = new Color(.025f, .075f, .14f, .78f);
        static readonly Color KitLine = new Color(0, .8f, .95f, .55f);
        static readonly Color KitSoft = new Color(.78f, .86f, .94f);
        static readonly Color KitMuted = new Color(.55f, .64f, .74f);

        /// <summary>A translucent navy card with a thin cyan rule on top. Returns its transform for children.</summary>
        RectTransform Card(string name, float x, float y, float w, float h, Transform parent = null)
        {
            var p = Panel(name, x, y, w, h, KitPanel, parent);
            var rule = Rect(name + " / rule", p.transform, 0, 0, w, 3);
            rule.gameObject.AddComponent<Image>().color = KitLine;
            return p.rectTransform;
        }

        /// <summary>A small letter-spaced cyan label (「目標」 → 「目　標」 feel through spacing; Latin is upper-cased).</summary>
        Text Kicker(string value, float x, float y, float w, Transform parent = null)
        {
            var t = Label(value, x, y, w, 24, BodyMin, cyan, parent);
            t.text = Spaced(t.text);
            return t;
        }

        static string Spaced(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            var upper = s.ToUpperInvariant();
            var sb = new System.Text.StringBuilder(upper.Length * 2);
            for (int i = 0; i < upper.Length; i++) { if (i > 0 && upper[i] != ' ' && upper[i - 1] != ' ') sb.Append(' '); sb.Append(upper[i]); }
            return sb.ToString();
        }

        /// <summary>Body text with the 16 px floor enforced.</summary>
        Text Body(string value, float x, float y, float w, float h, int size = 20, Color? color = null, Transform parent = null)
        {
            var t = Label(value, x, y, w, h, Math.Max(BodyMin, size), color ?? KitSoft, parent);
            t.fontStyle = FontStyle.Normal; t.horizontalOverflow = HorizontalWrapMode.Wrap;
            return t;
        }

        /// <summary>The one primary action: a skewed cyan bar with 「»」. One per screen.</summary>
        Button Cta(string value, float x, float y, float w, Action action, Transform parent = null)
        {
            var r = Rect("CTA / " + value, parent ?? safe, x, y, w, 76);
            var img = r.gameObject.AddComponent<Image>(); img.color = cyan;
            r.localRotation = Quaternion.identity;
            var skew = r.gameObject.AddComponent<SkewEffect>(); skew.Amount = 18f;
            var b = r.gameObject.AddComponent<Button>(); b.onClick.AddListener(() => action());
            var t = Label(value + "　»", 28, 14, w - 56, 48, 27, navy, r); t.alignment = TextAnchor.MiddleLeft;
            return b;
        }

        /// <summary>A secondary action: outlined, never cyan-filled.</summary>
        Button Ghost(string value, float x, float y, float w, Action action, Transform parent = null)
        {
            var p = Panel("Ghost / " + value, x, y, w, 64, new Color(0, 0, 0, .25f), parent);
            var o = p.gameObject.AddComponent<Outline>(); o.effectColor = KitLine; o.effectDistance = new Vector2(1.5f, -1.5f);
            var b = p.gameObject.AddComponent<Button>(); b.onClick.AddListener(() => action());
            var t = Label(value, 12, 10, w - 24, 44, 21, Color.white, p.transform); t.alignment = TextAnchor.MiddleCenter;
            return b;
        }

        /// <summary>
        /// The shared claim / reveal moment: dims the screen, light behind the picture, a kicker, one headline, one line,
        /// one button. Mirrors the prototype's Moment(); every claim of something worth a moment uses it (not a toast).
        /// </summary>
        void Moment(string kicker, string headline, string line, string art, string button, Action done)
        {
            var dim = Panel("Moment", 0, 0, 1600, 900, new Color(0, .02f, .05f, .82f));
            var glow = Panel("Moment / light", 560, 120, 480, 480, new Color(0, .8f, .95f, .16f), dim.transform);
            if (!string.IsNullOrEmpty(art)) ArtImage(art, 620, 170, 360, 360, dim.transform);
            Kicker(kicker, 400, 580, 800, dim.transform).alignment = TextAnchor.MiddleCenter;
            var h = Label(headline, 300, 612, 1000, 56, 40, Color.white, dim.transform); h.alignment = TextAnchor.MiddleCenter;
            if (!string.IsNullOrEmpty(line)) Body(line, 300, 672, 1000, 34, 20, KitSoft, dim.transform).alignment = TextAnchor.MiddleCenter;
            Cta(button, 620, 740, 360, () => { Destroy(dim.gameObject); done?.Invoke(); }, dim.transform);
        }
    }

    /// <summary>Skews a Graphic horizontally (the CTA's slanted bar) without a custom material.</summary>
    public sealed class SkewEffect : BaseMeshEffect
    {
        public float Amount = 18f;
        public override void ModifyMesh(VertexHelper vh)
        {
            if (!IsActive()) return;
            var v = new UIVertex();
            var rect = ((RectTransform)transform).rect;
            for (int i = 0; i < vh.currentVertCount; i++)
            {
                vh.PopulateUIVertex(ref v, i);
                float t = rect.height <= 0 ? 0 : (v.position.y - rect.yMin) / rect.height;
                v.position.x += (t - .5f) * Amount;
                vh.SetUIVertex(v, i);
            }
        }
    }
}
