// Round 20 integration (contracts/protocol.md §58.11, §59, §61; docs/planning/06): at most one system-ish prompt per session,
// and what a change of account resets on this device. No UnityEngine here (Muchi.Game is engine-free).
using System;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>The prompts that ask the player for something on top of the game (each may lead to an OS dialog).</summary>
    public enum SessionPromptKind
    {
        /// <summary>§58: the ads / analytics pre-prompt (then ATT / the CMP form).</summary>
        Consent = 0,
        /// <summary>§61: the local reminders pre-permission sheet (then the OS notification dialog).</summary>
        Notifications = 1,
        /// <summary>§59: the store review request (soft sheet or the OS sheet).</summary>
        Review = 2,
    }

    /// <summary>
    /// REQ-CNS / REQ-LNOTIF / REQ-REV (R20 integration): <b>at most one system-ish prompt per session</b> (one app launch, or
    /// until the account changes). The first one shown claims the session; the others wait for a later session (their own
    /// rules keep them due — nothing is lost). When two are due at the same moment the order is
    /// <see cref="SessionPromptKind.Consent"/> → <see cref="SessionPromptKind.Notifications"/> → <see cref="SessionPromptKind.Review"/>:
    /// consent first (personalised ads and analytics must be decided before they are used), then the reminders (useful to the
    /// player right after a training), the review last (only ever a request). None of them shows during the FTUE (each
    /// model's own rule). So the ATT / consent sheet and the notification sheet are never back to back, and the review never
    /// follows either of them in the same session. One gate per session is shared by ConsentModel, LocalNotificationModel
    /// and ReviewPromptModel (their <c>Prompts</c> property).
    /// </summary>
    public sealed class SessionPromptGate
    {
        /// <summary>The prompt shown this session (null = none yet).</summary>
        public SessionPromptKind? Shown { get; private set; }

        /// <summary>Whether <paramref name="kind"/> may show now (nothing else showed this session; the same one again is fine).</summary>
        public bool CanShow(SessionPromptKind kind) => Shown == null || Shown == kind;

        /// <summary>Records that <paramref name="kind"/> is on screen. Returns false (and changes nothing) when another one already showed.</summary>
        public bool Claim(SessionPromptKind kind)
        {
            if (!CanShow(kind)) return false;
            Shown = kind;
            return true;
        }

        /// <summary>Of the prompts due at one moment, the one to show (by the order above), or null when none may show.</summary>
        public SessionPromptKind? Pick(bool consentDue, bool notificationsDue, bool reviewDue)
        {
            if (consentDue && CanShow(SessionPromptKind.Consent)) return SessionPromptKind.Consent;
            if (notificationsDue && CanShow(SessionPromptKind.Notifications)) return SessionPromptKind.Notifications;
            if (reviewDue && CanShow(SessionPromptKind.Review)) return SessionPromptKind.Review;
            return null;
        }

        /// <summary>A new session (a new account on this device): any prompt may show again under its own rules.</summary>
        public void Reset() => Shown = null;
    }

    /// <summary>
    /// R20 integration (§54 × §59 / §60 / §61): what this device forgets when the signed-in account changes — a 401
    /// SESSION_REPLACED (the account moved to another phone), a redeemed 引き継ぎコード, or a new start / sign-out:
    /// the local reminders are cancelled and forgotten (<see cref="LocalNotificationModel.ForgetAll"/>), the error reporter
    /// sends what it queued for the old account without a player id (<see cref="ErrorReporter.AccountChanged"/>), the review
    /// prompt starts a new session (<see cref="ReviewPromptModel.ResetSession"/>) and the one-prompt gate is reset.
    /// Any part may be null. Hook it with <see cref="Watch(MaintenanceModel)"/> and <see cref="Watch(TransferCodeModel)"/>.
    /// </summary>
    public sealed class AccountChangeReset
    {
        public LocalNotificationModel Reminders { get; set; }
        public ClientErrorModel Errors { get; set; }
        public ReviewPromptModel Review { get; set; }
        public SessionPromptGate Prompts { get; set; }
        /// <summary>How many times the device state was reset (for checks).</summary>
        public int Resets { get; private set; }

        public void OnAccountChanged()
        {
            Resets++;
            Guard(() => Reminders?.ForgetAll());
            Guard(() => Errors?.Reporter.AccountChanged());
            Guard(() => Review?.ResetSession());
            Prompts?.Reset();
        }

        /// <summary>SESSION_REPLACED: the screen appears (MaintenanceModel.SessionReplacedShown).</summary>
        public void Watch(MaintenanceModel maintenance)
        {
            if (maintenance == null) throw new ArgumentNullException(nameof(maintenance));
            maintenance.SessionReplacedShown += OnAccountChanged;
        }

        /// <summary>A transfer code redeemed and signed in on this device (TransferCodeModel.Redeemed).</summary>
        public void Watch(TransferCodeModel transfer)
        {
            if (transfer == null) throw new ArgumentNullException(nameof(transfer));
            transfer.Redeemed += OnAccountChanged;
        }

        private static void Guard(Action a) { try { a(); } catch (Exception) { /* one part failing never blocks the others */ } }
    }
}
