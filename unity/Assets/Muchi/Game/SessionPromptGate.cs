// Round 20 / 21 integration (contracts/protocol.md §58.11, §59, §61, §63, §64; docs/planning/06): what goes with the one
// prompt gate (Muchi.Client.SessionPrompts), and what a change of account resets on this device. No UnityEngine here (Muchi.Game is engine-free).
using System;
using Muchi.Client;

namespace Muchi.Game
{
    // R21 integration (§58.11 = §64.6): the Round 20 SessionPromptGate (consent → reminders → review) and the Round 21
    // SessionPrompts.TryClaim list were two gates for one rule. They are one now: Muchi.Client.SessionPrompts, with one priority
    // table (recommended update > consent pre-prompt > comeback welcome > release notes > reminders pre-permission card >
    // account-link prompt > review prompt), at most one per session, none in the FTUE, none over a §46 screen. Every model
    // that can interrupt the player takes the same instance through its Prompts property (ReleaseNotesModel through its
    // constructor). This file keeps the device-side pieces that go with it.

    /// <summary>R20 integration (§58.10): <c>clientErrorModel.FollowConsent(consentModel)</c>.</summary>
    public static class ClientErrorConsentExtensions
    {
        public static void FollowConsent(this ClientErrorModel errors, ConsentModel consent)
        {
            if (errors == null) throw new ArgumentNullException(nameof(errors));
            if (consent == null) throw new ArgumentNullException(nameof(consent));
            errors.FollowConsent(() => consent.State);
        }
    }

    /// <summary>
    /// R20 integration (§54 × §59 / §60 / §61): what this device forgets when the signed-in account changes — a 401
    /// SESSION_REPLACED (the account moved to another phone), a 401 SESSION_REVOKED (Round 23 §70: this device was signed
    /// out from another device or by support), a redeemed 引き継ぎコード, or a new start / sign-out:
    /// the local reminders are cancelled and forgotten (<see cref="LocalNotificationModel.ForgetAll"/>; the §65 calendar
    /// reminders are among them), the error reporter sends what it queued for the old account without a player id
    /// (<see cref="ErrorReporter.AccountChanged"/>), the review prompt starts a new session (<see cref="ReviewPromptModel.ResetSession"/>),
    /// R21 integration: a deferred deep link waiting on this device is dropped (<see cref="DeepLinkModel.ForgetPending"/> —
    /// it was received for the old account), the release notes' "shown this session" goes (<see cref="ReleaseNotesModel.NewSession"/>:
    /// "seen" is per account on the server), Round 23: the cached device list and security log go (<see cref="DeviceSessionsModel.ForgetAll"/>),
    /// and the one prompt gate starts a new session.
    /// Any part may be null. Hook it with <see cref="Watch(MaintenanceModel)"/> and <see cref="Watch(TransferCodeModel)"/>.
    /// </summary>
    public sealed class AccountChangeReset
    {
        public LocalNotificationModel Reminders { get; set; }
        public ClientErrorModel Errors { get; set; }
        public ReviewPromptModel Review { get; set; }
        public SessionPrompts Prompts { get; set; }
        /// <summary>R21 integration (§63): the deferred deep link waiting on this device.</summary>
        public DeepLinkModel Links { get; set; }
        /// <summary>R21 integration (§64): the release notes sheet's per-session state.</summary>
        public ReleaseNotesModel ReleaseNotes { get; set; }
        /// <summary>Round 23 (§70): the cached device list and security log (they belong to the old account).</summary>
        public DeviceSessionsModel Devices { get; set; }
        /// <summary>How many times the device state was reset (for checks).</summary>
        public int Resets { get; private set; }

        public void OnAccountChanged()
        {
            Resets++;
            Guard(() => Reminders?.ForgetAll());
            Guard(() => Errors?.Reporter.AccountChanged());
            Guard(() => Review?.ResetSession());
            Guard(() => Links?.ForgetPending());
            Guard(() => ReleaseNotes?.NewSession());
            Guard(() => Devices?.ForgetAll());
            Prompts?.NewSession();
        }

        /// <summary>SESSION_REPLACED / (Round 23) SESSION_REVOKED: the screen appears (MaintenanceModel.SessionReplacedShown / SessionRevokedShown).</summary>
        public void Watch(MaintenanceModel maintenance)
        {
            if (maintenance == null) throw new ArgumentNullException(nameof(maintenance));
            maintenance.SessionReplacedShown += OnAccountChanged;
            maintenance.SessionRevokedShown += OnAccountChanged;
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
