using System;
using Muchi.Engine;

namespace Muchi.Client
{
    /// <summary>
    /// Quality pass 2 (docs/quality/ranked.md §4): after a ranked loss, which side of the result the player can work on — the
    /// horse or the riding. Compares the player's horse (stat total as it raced, after the class cap) with the CPU field of the
    /// race (their average total; since REQ-MM-012 a class's CPUs race at the class strength). Clearly weaker → train the horse;
    /// otherwise → the gap was the riding (the 敗因 and 振り返り lines above it say what in the riding). From the race config
    /// only, deterministic, no invented numbers. Shown in the result's one 振り返り row (no new sheet).
    /// </summary>
    public sealed class RankedFieldCheck
    {
        /// <summary>The horse is "clearly weaker" below this share of the field's average total (‰).</summary>
        public const int WeakerBelowPermille = 980;

        public int HorseTotal, FieldTotal;
        public bool HorseWeaker;
        public string Line;

        public static int Total(HorseSpec h) => h.Speed + h.Stamina + h.Burst + h.Guts + h.Temper;

        /// <summary>The check for a ranked race the player lost (place ≥ 2); null for other modes, a win, or a field without CPUs.</summary>
        public static RankedFieldCheck For(RaceConfig config, int slot, int place)
        {
            if (config == null || config.Mode != RaceMode.Ranked || place < 2 || slot < 0 || slot >= config.Entrants.Count) return null;
            long sum = 0; int n = 0;
            foreach (var e in config.Entrants)
            {
                if (e.Kind != EntrantKind.Cpu) continue;
                sum += Total(e.Horse); n++;
            }
            if (n == 0) return null;
            var r = new RankedFieldCheck { HorseTotal = Total(config.Entrants[slot].Horse), FieldTotal = (int)(sum / n) };
            r.HorseWeaker = (long)r.HorseTotal * 1000 < (long)r.FieldTotal * WeakerBelowPermille;
            r.Line = r.HorseWeaker
                ? "能力の差：相棒 " + r.HorseTotal + " ／ この場のCPU " + r.FieldTotal + "。調教で伸ばすと勝ちやすい"
                : "能力は互角以上（相棒 " + r.HorseTotal + " ／ この場 " + r.FieldTotal + "）：差は乗り方";
            return r;
        }
    }
}
