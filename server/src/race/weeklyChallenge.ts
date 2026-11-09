import { AppError } from '../domain/errors.js';
import type { PlayerInvoker } from '../http/app.js';
import { signTicket, verifyTicket } from '../http/ticket.js';
import type { VerifierClient } from '../domain/verifier.js';
import type { Ruleset } from '../domain/ruleset.js';
import type { WchResult, WchStartInput } from '../domain/weeklyChallenge.js';

export interface WeeklyChallengePorts {
  player(uid: string): PlayerInvoker;
  verifier: VerifierClient;
  ticketSecret: string;
  clock: () => number;
  /** The active remote-config ruleset (embedded in the issued config with the day's form off). */
  activeRuleset?: () => Promise<Ruleset>;
}

export interface WchSubmitBody { sessionId: string; token: string; inputs: unknown; resultHash: string; config?: unknown }

const raceIdOf = (sessionId: string) => `wch_${sessionId}`;

/**
 * 週替わりチャレンジ orchestration (REQ-WCH-003/008, contracts/protocol.md §31): start → (device races the CPUs offline) →
 * submit → C# verifier re-simulates the issued config with the submitted inputs → the player's object evaluates the
 * conditions on the verified result and grants the week's reward once. The same path as time attack (§8): a client's
 * claim alone never clears a challenge.
 */
export class WeeklyChallengeService {
  constructor(private readonly p: WeeklyChallengePorts) {}

  async view(uid: string) {
    return this.p.player(uid).invoke('wchView', uid);
  }

  /** REQ-WCH-003: issue a session (keyed: a retried start returns the same session) and a token bound to player + session. */
  async start(uid: string, challengeId: string, input: WchStartInput, idemKey: string | null) {
    const ruleset = this.p.activeRuleset ? await this.p.activeRuleset() : undefined;
    const r = await this.p.player(uid).invoke('wchStart', uid, challengeId, input, idemKey, ruleset);
    const token = await signTicket({ raceId: raceIdOf(r.sessionId), slot: r.playerSlot, playerId: uid, exp: r.expiresAt }, this.p.ticketSecret);
    return { ...r, token };
  }

  /** REQ-WCH-008: submit inputs; idempotent per session (a retry with the same hash returns the stored result). */
  async submit(uid: string, b: WchSubmitBody): Promise<WchResult> {
    const t = await verifyTicket(b.token, this.p.ticketSecret, raceIdOf(b.sessionId), this.p.clock()).catch(() => {
      throw new AppError('CHALLENGE_SESSION_EXPIRED', 'invalid or expired session token');
    });
    if (t.playerId !== uid) throw new AppError('UNAUTHORIZED');
    const pl = this.p.player(uid);
    const prep = await pl.invoke('wchPrepare', uid, b.sessionId, b.inputs, b.resultHash, b.config);
    if (prep.kind === 'done') return prep.result;
    let out;
    try {
      out = await this.p.verifier.verify(prep.log);
    } catch (e) {
      await pl.invoke('wchAbort', uid, b.sessionId);
      throw new AppError('VERIFIER_UNAVAILABLE', (e as Error).message);
    }
    const rec = await pl.invoke('wchRecord', uid, b.sessionId, out, b.resultHash);
    if ('rejected' in rec) throw new AppError('CHALLENGE_RESULT_MISMATCH', 'the server re-simulation does not match the submitted run');
    return rec;
  }
}
