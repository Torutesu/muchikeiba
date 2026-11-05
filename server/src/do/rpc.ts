import { AppError, type ErrorCode } from '../domain/errors.js';

/** Workers RPC loses custom error fields, so DO methods return an envelope and the caller rethrows. */
export type Envelope<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string; status: number };

export async function wrap<T>(fn: () => T | Promise<T>): Promise<Envelope<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, code: e.code, message: e.message, status: e.status };
    throw e;
  }
}

export function unwrap<T>(e: Envelope<T>): T {
  if (e.ok) return e.value;
  throw new AppError(e.code, e.message, e.status);
}
