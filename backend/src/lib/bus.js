import { EventEmitter } from 'node:events';
import { col } from '../db.js';

/**
 * Central event bus. Everything the dashboard shows live flows through here:
 *  - 'log'   → human-readable decision/engine log (persisted)
 *  - 'state' → engine snapshot (throttled by the engine)
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

let clock = { now: () => new Date() };
/** Log timestamps follow the engine clock (virtual time in simulator mode). */
export const setLogClock = (c) => (clock = c);

/** Levels: info | signal | entry | exit | warn | error */
export function log(level, message, data = undefined) {
  const event = { ts: clock.now().toISOString(), level, message, ...(data ? { data } : {}) };
  const tag = level.toUpperCase().padEnd(6);
  console.log(`[${event.ts}] ${tag} ${message}`);
  bus.emit('log', event);
  try {
    col('events').insertOne({ ...event, tsDate: new Date() }).catch(() => {});
  } catch {
    /* db not connected yet (startup / tests) */
  }
  return event;
}
