using System;
using UnityEngine;

namespace Muchi.Client
{
    // Local presentation simulation. No ranked rewards or network authority.
    public sealed class RacePresentation
    {
        public const float Length = 420f;
        public readonly float[] Distance = new float[12];
        public float Time { get; private set; }
        public float Stamina { get; private set; } = 1f;
        public int Spurs { get; private set; } = 6;
        public int Place { get; private set; } = 12;
        public bool Finished { get; private set; }
        public bool LastSpurPerfect { get; private set; }
        readonly float[] previous = new float[12];
        readonly float[] finishTimes = new float[12];
        float boost;
        float cooldown;
        public void Reset()
        {
            Array.Clear(Distance, 0, Distance.Length);
            for (int i = 0; i < 12; i++) finishTimes[i] = float.PositiveInfinity;
            Time = boost = cooldown = 0; Stamina = 1; Spurs = 6;
            Place = 12; Finished = false;
        }
        public bool Spur()
        {
            if (Finished || Spurs == 0 || cooldown > 0 || Stamina < .12f) return false;
            LastSpurPerfect = Mathf.Sin(Time * 3) > .25f;
            boost = LastSpurPerfect ? 5 : 2.5f;
            Stamina -= .12f; Spurs--; cooldown = .8f; return true;
        }
        public void Step(float dt, bool rein)
        {
            if (Finished) return;
            Array.Copy(Distance, previous, 12);
            Time += dt; cooldown = Mathf.Max(0, cooldown - dt);
            boost = Mathf.MoveTowards(boost, 0, dt * .65f);
            Stamina = Mathf.Clamp01(Stamina + dt * (rein ? .075f : -.008f));
            if (Distance[0] < Length) Distance[0] += dt * ((rein ? 13 : 17) + boost + Stamina);
            for (int i = 1; i < 12; i++) if (Distance[i] < Length) Distance[i] += dt * (16.6f + i * .11f + Mathf.Sin(Time + i) * .35f);
            for (int i = 0; i < 12; i++)
                if (Distance[i] >= Length && float.IsPositiveInfinity(finishTimes[i]))
                {
                    float fraction = (Length - previous[i]) / Mathf.Max(.0001f, Distance[i] - previous[i]);
                    finishTimes[i] = Time - dt + dt * fraction;
                }
            for(int i=0;i<12;i++) Distance[i] = Mathf.Min(Length, Distance[i]);
            Place = 1;
            for (int i = 1; i < 12; i++)
                if (Distance[i] > Distance[0] || finishTimes[i] < finishTimes[0]) Place++;
            Finished = Distance[0] >= Length;
        }
    }
}
