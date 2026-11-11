import type { Master } from '../domain/master.js';
import type { OpsApi } from '../http/admin.js';
import type { PlayerInvoker } from '../http/app.js';
import { ConfigStore, MemoryConfigRepo } from './config.js';
import { CompensationStore, MemoryCompensationRepo } from './compensation.js';
import { auditValue, MemoryAuditRepo, RateLimiter, ADMIN_RATE, type RateLimitPolicy } from './admin.js';
import { IntegrityCore, MemoryIntegrityRepo, type ModerationChange } from './integrity.js';
import { MemoryPlayerReportRepo, PlayerReportsCore } from './playerReports.js';
import { InquiryIndex, MemoryInquiryIndexRepo } from './inquiries.js';
import { ClientErrorsCore, MemoryClientErrorRepo } from './clientErrors.js';
import { DeadLetterService, MemoryDeadLetterRegistry, type DeadLetterOwner, type DeadLetterSource } from './deadLetter.js';

/**
 * In-memory OpsApi (same domain classes as OpsDO / IntegrityDO, without Durable Objects).
 * Used by tests and local tooling. Moderation changes are pushed to the player like IntegrityDO does.
 */
export function memoryOps(base: Master, player: (uid: string) => PlayerInvoker, opts: { rate?: Record<'read' | 'write', RateLimitPolicy>; deadLetterOwners?: Partial<Record<DeadLetterSource, DeadLetterOwner>> } = {}) {
  const configRepo = new MemoryConfigRepo();
  const config = new ConfigStore(configRepo, base);
  const audits = new MemoryAuditRepo();
  const limiter = new RateLimiter(opts.rate ?? ADMIN_RATE);
  const integrityRepo = new MemoryIntegrityRepo();
  const integrity = new IntegrityCore(integrityRepo);
  const push = async (cs: ModerationChange[]) => {
    for (const c of cs) await player(c.playerId).invoke('setModeration', c.playerId, c.status, c.until, c.reason);
  };
  const deadLetterRegistry = new MemoryDeadLetterRegistry();
  const compensationRepo = new MemoryCompensationRepo();
  const compensations = new CompensationStore(compensationRepo);
  const playerReportRepo = new MemoryPlayerReportRepo();
  const playerReports = new PlayerReportsCore(playerReportRepo);
  const inquiryRepo = new MemoryInquiryIndexRepo();
  const inquiries = new InquiryIndex(inquiryRepo);
  const clientErrorRepo = new MemoryClientErrorRepo();
  const clientErrors = new ClientErrorsCore(clientErrorRepo);
  const api: OpsApi = {
    clientErrors: {
      ingest: async (b, who, now, cfg) => { const r = clientErrors.ingest(b, who, now, cfg); return { accepted: r.accepted, dropped: r.dropped, duplicate: r.duplicate }; },
      list: async (q, now, cfg) => clientErrors.list(q, now, cfg),
      get: async (fp, now) => clientErrors.get(fp, now),
      madeBy: async (pid) => clientErrors.madeBy(pid),
      forget: async (pid) => clientErrors.forgetPlayer(pid),
    },
    playerReports: {
      submit: async (x, now, cfg) => playerReports.submit(x, now, cfg),
      list: async (f) => playerReports.list(f),
      get: async (id, cfg) => playerReports.get(id, cfg),
      check: async (id, action) => playerReports.assertActionable(id, action),
      resolve: async (id, action, by, note, now) => playerReports.resolve(id, action, by, note, now),
      forget: async (uid) => playerReports.forgetPlayer(uid),
    },
    deadLetters: new DeadLetterService(deadLetterRegistry, opts.deadLetterOwners ?? {}),
    admit: async (id, kind, now) => { limiter.take(id, kind, now); return true; },
    audit: async (e, now) => audits.append({ ...e, before: auditValue(e.before), after: auditValue(e.after), at: now }),
    auditQuery: async (q) => audits.query(q),
    config: {
      active: async (now, known) => config.activeFor(now, known),
      validate: async (b) => ({ problems: config.validate(b) }),
      stage: (b, by, note, now) => config.stage(b, by, note, now),
      schedule: async (v, at, by, reason, now) => config.schedule(v, at, by, reason, now),
      cancel: async (id, now) => config.cancel(id, now),
      rollback: async (v, by, reason, now) => config.rollback(v, by, reason, now),
      list: async (now) => config.list(now),
      get: async (id) => config.get(id),
      dryRun: async (op, by, now) => config.dryRun(op, by, now),
    },
    compensations: {
      create: async (input, by, now) => compensations.create(input, by, now),
      get: async (id, now) => compensations.get(id, now),
      list: async (q, now) => compensations.list(q, now),
      approve: async (id, by, note, now) => compensations.approve(id, by, note, now),
      reject: async (id, by, note, now) => compensations.reject(id, by, note, now),
      executed: async (id, error, now) => compensations.executed(id, error, now),
    },
    inquiries: {
      upsert: async (items) => inquiries.upsert(items),
      list: async (q) => inquiries.list(q),
      forgetPlayer: async (pid) => inquiries.forgetPlayer(pid),
    },
    integrity: {
      recordRace: async (r) => { const cs = integrity.recordRace(r); await push(cs); return cs; },
      report: async (raceId, reporter, now) => integrity.addReport(raceId, reporter, now),
      reports: async (st, limit) => integrity.reports(st, limit),
      resolveReport: async (id, res, by, now) => integrity.resolveReport(id, res, by, now),
      view: async (pid, now) => integrity.view(pid, now),
      list: async (st, now, limit) => integrity.list(st, now, limit),
      ban: async (pid, until, reason, by, now) => { const c = integrity.ban(pid, until, reason, by, now); await push([c]); return c; },
      unban: async (pid, reason, by, now) => { const c = integrity.unban(pid, reason, by, now); await push([c]); return c; },
      release: async (pid, reason, by, now) => { const c = integrity.release(pid, reason, by, now); await push([c]); return c; },
    },
  };
  return { api, config, audits, integrity, integrityRepo, deadLetterRegistry, compensationRepo, inquiryRepo, playerReportRepo, clientErrorRepo, clientErrors };
}
