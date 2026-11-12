import { AppError } from '../domain/errors.js';
import type { PlayerInvoker } from '../http/app.js';
import { signTicket, verifyTicket } from '../http/ticket.js';
import type { VerifierClient } from '../domain/verifier.js';
import type { Ruleset } from '../domain/ruleset.js';
import type { CareerResult } from '../domain/career.js';
import type { Locale } from '../i18n/locale.js';

export interface CareerPorts {
  player(uid: string): PlayerInvoker;
  verifier: VerifierClient;
  ticketSecret: string;
  clock: () => number;
  /** The active remote-config ruleset (embedded in the issued config with the day's form off). */
  activeRuleset?: () => Promise<Ruleset>;
}

export interface CareerSubmitBody { sessionId: string; token: string; inputs: unknown; resultHash: string; config?: unknown }

const raceIdOf = (sessionId: string) => `car_${sessionId}`;

/**
 * 騎手の道 orchestration (REQ-CAREER-004/007, contracts/protocol.md §66): start → (device races the CPUs offline) → submit →
 * C# verifier re-simulates the issued config with the submitted inputs → the player's object evaluates the objectives and
 * pays the first clear / new stars once ever. The weekly challenge path (§31): a client's claim alone never clears a race.
 */
export class CareerService {
  constructor(private readonly p: CareerPorts) {}

  async view(uid: string, lang: Locale) {
    return this.p.player(uid).invoke('careerView', uid, lang);
  }

  /** REQ-CAREER-004: issue a session (keyed: a retried start returns the same session) and a token bound to player + session. */
  async start(uid: string, raceId: string, horseId: string, idemKey: string | null, lang: Locale) {
    const ruleset = this.p.activeRuleset ? await this.p.activeRuleset() : undefined;
    const r = await this.p.player(uid).invoke('careerStart', uid, raceId, horseId, idemKey, ruleset, lang);
    const token = await signTicket({ raceId: raceIdOf(r.sessionId), slot: r.playerSlot, playerId: uid, exp: r.expiresAt }, this.p.ticketSecret);
    return { ...r, token };
  }

  /** REQ-CAREER-007: submit inputs; idempotent per session (a retry with the same hash returns the stored result). */
  async submit(uid: string, b: CareerSubmitBody): Promise<CareerResult> {
    const t = await verifyTicket(b.token, this.p.ticketSecret, raceIdOf(b.sessionId), this.p.clock()).catch(() => {
      throw new AppError('CAREER_SESSION_EXPIRED', 'invalid or expired session token');
    });
    if (t.playerId !== uid) throw new AppError('UNAUTHORIZED');
    const pl = this.p.player(uid);
    const prep = await pl.invoke('careerPrepare', uid, b.sessionId, b.inputs, b.resultHash, b.config);
    if (prep.kind === 'done') return prep.result;
    let out;
    try {
      out = await this.p.verifier.verify(prep.log);
    } catch (e) {
      await pl.invoke('careerAbort', uid, b.sessionId);
      throw new AppError('VERIFIER_UNAVAILABLE', (e as Error).message);
    }
    const rec = await pl.invoke('careerRecord', uid, b.sessionId, out, b.resultHash);
    if ('rejected' in rec) throw new AppError('CAREER_RESULT_MISMATCH', 'the server re-simulation does not match the submitted run');
    return rec;
  }
}
