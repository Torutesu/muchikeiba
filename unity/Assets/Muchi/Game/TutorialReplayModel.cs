using System;
using System.Linq;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>
    /// REQ-TUT-002..004 (contracts/protocol.md §57.4): a race lesson replayed from ヒント. It runs on the device like practice,
    /// built from the existing parts — never a fork of the tutorial:
    ///  - whip: the FTUE tutorial race itself (<see cref="GameBackend.CreateTutorialRace"/> with an explicit attempt 1, so the
    ///    TutorialDirector applies the honest rule — 2+ whips in the last 300 m win, 0–1 finish a close 2nd — and the FTUE's
    ///    stored attempt count is neither read nor written);
    ///  - position / stamina / reins: the §50 practice race built by PracticeSession (<see cref="GameBackend.CreateLessonRace"/>,
    ///    R19 integration: one practice path) without かんたん操作.
    /// The in-race coaching is the existing RaceFeel line; <see cref="FocusOf"/> says which cues the lesson highlights.
    /// Nothing here touches <see cref="OnboardingFlow"/> (its step, its tutorial_step KPI) or the server: a replay never
    /// counts as a race and grants nothing. The only trace is the tutorial_replay KPI row (start / finish).
    /// </summary>
    public sealed class TutorialReplayModel
    {
        public const string Title = "レースのレッスン";
        public const string StartLabel = "レッスンを始める";
        public const string RetryLabel = "もう一度";
        public const string BackLabel = "ヒントに戻る";
        public const string WonText = "差し切った！";
        public const string WhipLostText = "あと少し。残り300mからムチを2回";
        public const string DoneText = "レッスン完了";
        /// <summary>Shown on the briefing and the result: a lesson is practice (REQ-TUT-004).</summary>
        public const string PracticeNote = "レッスンは練習です。成績・ミッション・報酬には数えません";

        private readonly GameBackend _b;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;
        private readonly Func<ulong> _seed;

        public TutorialReplayModel(GameBackend backend, Action<AnalyticsEvent> track = null, Func<long> clock = null, Func<ulong> seed = null)
        {
            _b = backend ?? throw new ArgumentNullException(nameof(backend));
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _seed = seed ?? (() => (ulong)_clock());
        }

        public TutorialEntry Lesson { get; private set; }
        /// <summary>Tries of this lesson since it was opened (the FTUE's own count is separate).</summary>
        public int Tries { get; private set; }
        public bool Running { get; private set; }
        public bool Won { get; private set; }
        public string ResultText { get; private set; }

        /// <summary>The RaceFeel cues a lesson highlights (the HUD shows every hint as usual; these get the lesson's frame).</summary>
        public static RaceFeelCueKind[] FocusOf(string lesson)
        {
            switch (lesson)
            {
                case RaceLessons.Whip: return new[] { RaceFeelCueKind.WhipChance, RaceFeelCueKind.WhipMash };
                case RaceLessons.Position: return new[] { RaceFeelCueKind.SlipstreamOn, RaceFeelCueKind.Overtake };
                case RaceLessons.Stamina: return new[] { RaceFeelCueKind.StaminaLow, RaceFeelCueKind.StaminaCritical, RaceFeelCueKind.StaminaEmpty, RaceFeelCueKind.Runaway };
                case RaceLessons.Reins: return new[] { RaceFeelCueKind.Kakari, RaceFeelCueKind.Runaway };
                default: return Array.Empty<RaceFeelCueKind>();
            }
        }

        public bool Highlights(RaceFeelCue cue) => Lesson != null && FocusOf(Lesson.Lesson).Contains(cue.Kind);

        /// <summary>Opens a lesson (its briefing cards are <see cref="TutorialEntry.Tips"/>). Only a race lesson.</summary>
        public bool Open(TutorialEntry lesson)
        {
            if (lesson == null || lesson.Kind != TutorialEntry.KindRace || Array.IndexOf(RaceLessons.All, lesson.Lesson) < 0) return false;
            Lesson = lesson; Tries = 0; Running = false; Won = false; ResultText = null;
            return true;
        }

        /// <summary>Starts (or restarts, もう一度) the lesson race on the device. KPI tutorial_replay start each time.</summary>
        public IRaceDriver StartRace()
        {
            if (Lesson == null) throw new InvalidOperationException("open a lesson first");
            Tries++;
            Running = true; Won = false; ResultText = null;
            _track?.Invoke(AnalyticsEvent.TutorialReplay(_clock(), Lesson.Id, TutorialEntry.KindRace, "start"));
            return Lesson.Lesson == RaceLessons.Whip
                ? _b.CreateTutorialRace(1) // explicit attempt: the FTUE count is not touched and the race is never assisted
                : _b.CreateLessonRace(PracticeSession.NextSeed(_seed() + (ulong)Tries)); // a new seed per try
        }

        /// <summary>The lesson race finished. The whip lesson has a win condition (the tutorial's); the others finish when run.</summary>
        public void FinishRace(RaceResultModel result)
        {
            if (Lesson == null || !Running || result == null || !result.HasResult) return;
            Running = false;
            bool whip = Lesson.Lesson == RaceLessons.Whip;
            Won = !whip || result.Won;
            ResultText = whip ? (result.Won ? WonText : WhipLostText) : DoneText;
            _track?.Invoke(AnalyticsEvent.TutorialReplay(_clock(), Lesson.Id, TutorialEntry.KindRace, "finish"));
        }

        public void Close() { Lesson = null; Running = false; Tries = 0; ResultText = null; Won = false; }
    }
}
