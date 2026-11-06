import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { loadMaster } from '../domain/master.js';
import { PlayerService } from '../domain/service.js';
import { cryptoRng } from '../domain/rng.js';
import { systemClock } from '../domain/time.js';
import type { PlayerMethod } from '../http/app.js';
import { makeVerifiers, storeSettingsFromEnv } from '../http/stores.js';
import { accountingStoreIndex } from './storeIndex.js';
import { SqlPlayerRepo } from './sqlRepo.js';
import { unwrap, wrap, type Envelope } from './rpc.js';
import { retryStudOutbox } from '../domain/studService.js';
import { activeConfig } from '../ops/activeConfig.js';
import { shardedDirectory, shardedStableDirectory } from './directory.js';
import { fcmFromEnv, type PushSender } from '../push/fcm.js';
import { deliverDuePushes } from '../push/dispatch.js';
import { makeKpiWriter } from '../push/analytics.js';
import { runAccountDeletion } from '../domain/accountDeletion.js';
import { deletionPortsFromEnv } from './deletionPorts.js';

/** One player = one Durable Object (wallet, ledger, horses, gacha pity, purchases, push outbox). */
export class PlayerDO extends DurableObject<Env> {
  private readonly svc: PlayerService;
  private readonly sender: PushSender | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const master = loadMaster();
    this.sender = fcmFromEnv(env);
    const kpi = makeKpiWriter(env.ANALYTICS, env.KPI_SALT);
    this.svc = new PlayerService(new SqlPlayerRepo(ctx.storage.sql), {
      master, rng: cryptoRng, clock: systemClock, verifiers: makeVerifiers(storeSettingsFromEnv(env, master)),
      storeIndex: accountingStoreIndex(env),
      onPaidBalance: (snap) => {
        const acc = env.ACCOUNTING.get(env.ACCOUNTING.idFromName('global')) as unknown as { record(s: typeof snap): Promise<void> };
        // Ordering is safe (seq-guarded); retry once so a transient failure does not leave a stale balance.
        ctx.waitUntil(acc.record(snap).catch(() => acc.record(snap)).catch((e) => console.error('paid balance record failed', snap.playerId, e)));
      },
      onSeasonEntry: (e) => {
        const lb = env.LEADERBOARD.get(env.LEADERBOARD.idFromName(`lb:${e.seasonId}`)) as unknown as { upsert(x: typeof e): Promise<unknown> };
        ctx.waitUntil(lb.upsert(e));
      },
      onProfile: (p) => {
        ctx.waitUntil(shardedDirectory(env.DIRECTORY).putProfile(p));
      },
      // REQ-STABLE-003: keep the visitors' copy of the stable in step with this object (null = hidden/cleared)
      onStable: (id, snap) => {
        const dir = shardedStableDirectory(env.DIRECTORY);
        ctx.waitUntil((snap ? dir.put(snap) : dir.remove(id)).catch((e) => console.error('stable copy failed', id, e)));
      },
      // REQ-TEAM-005: the team recomputes its points from members' reported standings
      onTeamPoints: (p) => {
        const team = env.TEAMS.get(env.TEAMS.idFromName(p.teamId)) as unknown as { reportPoints(a: string, b: string, c: number, d: string): Promise<unknown> };
        ctx.waitUntil(team.reportPoints(p.playerId, p.seasonId, p.points, p.displayName).catch((e) => console.error('team points report failed', p.teamId, e)));
      },
      // REQ-TEAMFEED-004: a win / place in ranked or a tournament → the team feed (best effort)
      onTeamFeed: (p) => {
        const team = env.TEAMS.get(env.TEAMS.idFromName(p.teamId)) as unknown as { feedRace(a: string, r: typeof p.race): Promise<unknown> };
        ctx.waitUntil(team.feedRace(p.playerId, p.race).catch((e) => console.error('team feed race item failed', p.teamId, e)));
      },
      // REQ-EVENT-007: event standing → the event's board
      onEventEntry: (e) => {
        const ev = env.EVENTS.get(env.EVENTS.idFromName(`ev:${e.eventId}`)) as unknown as { upsert(x: typeof e): Promise<unknown> };
        ctx.waitUntil(ev.upsert(e).catch((err) => console.error('event entry upsert failed', e.eventId, err)));
      },
      // REQ-PUSH-005: deliveries run from this object's alarm, never on the request path.
      onPushWake: async (at) => {
        const cur = await ctx.storage.getAlarm();
        if (cur === null || at < cur) await ctx.storage.setAlarm(Math.max(at, Date.now()));
      },
      ...(kpi ? { onKpi: (id: string, recs: Parameters<typeof kpi>[1]) => { ctx.waitUntil(kpi(id, recs)); } } : {}),
    });
  }

  private idKnown = false;

  async invoke(method: PlayerMethod, args: unknown[]): Promise<Envelope<unknown>> {
    // Every PlayerService method takes the player id first; remember it for the alarm (which has no caller).
    if (!this.idKnown && typeof args[0] === 'string') {
      if ((await this.ctx.storage.get<string>('playerId')) !== args[0]) await this.ctx.storage.put('playerId', args[0]);
      this.idKnown = true;
    }
    return wrap(async () => {
      this.svc.setMaster((await activeConfig(this.env)).master); // REQ-OPS-005: gacha schedule, rewards… follow remote config
      return (this.svc[method] as (...a: unknown[]) => unknown)(...args);
    });
  }

  /** Push outbox delivery and stud fee retries (with backoff). The player id was stored by the first invoke(). */
  override async alarm() {
    const id = await this.ctx.storage.get<string>('playerId');
    if (!id) return;
    // templates may exist only in remote config (REQ-OPS-005); a fresh object starts with the base master
    this.svc.setMaster((await activeConfig(this.env)).master);
    // REQ-UXS-040: a scheduled account deletion that is due runs first; after the wipe nothing else may touch the
    // player (any call would recreate a fresh state), so the alarm ends there
    if (await this.svc.deletionDue(id)) {
      try {
        await runAccountDeletion(deletionPortsFromEnv(this.env, this.ctx, this.svc), id, Date.now());
        this.idKnown = false;
        console.log('account deleted');
        return;
      } catch (e) {
        console.error('account deletion failed; retrying later', id, (e as Error).message);
        const at = await this.svc.deletionRetryLater(id);
        if (at !== null) await this.ctx.storage.setAlarm(at);
        return;
      }
    }
    // REQ-UXS-012: personal nudges (promotion) that are due
    await this.svc.runNudges(id).catch((e) => console.error('nudges failed', id, e));
    const r = await deliverDuePushes({ take: (p) => this.svc.pushTake(p), settle: (p, o) => this.svc.pushSettle(p, o) }, id, this.sender);
    if (r.attempted > 0 || r.expired > 0) console.log('push', id, JSON.stringify(r));
    // REQ-BREED-012: stud fees this player paid that the owner has not acknowledged yet
    const owner = (uid: string) => this.env.PLAYER.get(this.env.PLAYER.idFromName(uid)) as unknown as { invoke(m: PlayerMethod, a: unknown[]): Promise<Envelope<unknown>> };
    const sr = await retryStudOutbox({
      due: (u) => this.svc.studDue(u),
      later: (u, op) => this.svc.studRetryLater(u, op),
      settle: async (o, op, ok, info) => unwrap(await owner(o).invoke('studSettle', [o, op, ok, info])) as { status: string; paid: number },
      acked: (u, op) => this.svc.studAcked(u, op),
    }, id).catch((e) => { console.error('stud outbox retry failed', id, e); return null; });
    if (sr && sr.attempted > 0) console.log('stud', id, JSON.stringify(sr));
    const studNext = (await this.svc.studDue(id)).nextAt;
    const own = await this.svc.nextWakeOf(id); // nudges, a scheduled deletion
    const next = [r.nextAt, studNext, own].filter((x): x is number => x !== null).reduce<number | null>((a, x) => (a === null ? x : Math.min(a, x)), null);
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }
}
