/**
 * Persistence.
 *
 * localStorage, with a version tag so a schema change can be handled rather
 * than silently corrupting a save. Also exports JSON, because a player who
 * wants their progress backed up should not need devtools.
 */

import type { PlayerState } from '../game/Economy';
import { newPlayer } from '../game/Economy';

const KEY = 'caustic.save.v1';

export interface SaveFile {
  version: 1;
  state: SerialisedState;
}

export interface SerialisedState {
  cash: number;
  xp: number;
  level: number;
  garage: Array<{ carId: string; tuning: string[]; condition: number; paid: number }>;
  beaten: string[];
  bestEt: number;
  racesRun: number;
  perfectLaunches: number;
  activeCarId: string;
  rivalIndex: number;
}

/** Sets are not JSON, so the save file stores plain arrays. */
export function serialise(state: PlayerState, activeCarId: string, rivalIndex: number): SerialisedState {
  return {
    cash: state.cash,
    xp: state.xp,
    level: state.level,
    garage: state.garage.map((g) => ({
      carId: g.carId,
      tuning: [...g.tuning],
      condition: g.condition,
      paid: g.paid,
    })),
    beaten: [...state.beaten],
    bestEt: state.bestEt,
    racesRun: state.racesRun,
    perfectLaunches: state.perfectLaunches,
    activeCarId,
    rivalIndex,
  };
}

export function deserialise(data: SerialisedState): {
  state: PlayerState;
  activeCarId: string;
  rivalIndex: number;
} {
  const state = newPlayer();
  state.cash = num(data.cash, 0);
  state.xp = num(data.xp, 0);
  state.level = num(data.level, 1);
  state.bestEt = num(data.bestEt, 0);
  state.racesRun = num(data.racesRun, 0);
  state.perfectLaunches = num(data.perfectLaunches, 0);
  state.beaten = new Set(Array.isArray(data.beaten) ? data.beaten.filter((b) => typeof b === 'string') : []);
  state.garage = Array.isArray(data.garage)
    ? data.garage
        .filter((g) => g && typeof g.carId === 'string')
        .map((g) => ({
          carId: g.carId,
          tuning: Array.isArray(g.tuning) ? (g.tuning as never[]) : [],
          condition: clamp(num(g.condition, 1), 0.35, 1),
          paid: num(g.paid, 0),
        }))
    : state.garage;

  // A save with no cars is unusable; fall back rather than soft-lock.
  if (state.garage.length === 0) state.garage = [{ carId: 'rusty8', tuning: [], condition: 1, paid: 0 }];
  const owned = state.garage.map((g) => g.carId);
  const activeCarId = owned.includes(data.activeCarId) ? data.activeCarId : owned[0];
  return { state, activeCarId, rivalIndex: Math.max(0, num(data.rivalIndex, 0)) };
}

export function save(
  state: PlayerState, activeCarId: string, rivalIndex: number,
): { ok: boolean; error?: string } {
  try {
    const file: SaveFile = { version: 1, state: serialise(state, activeCarId, rivalIndex) };
    localStorage.setItem(KEY, JSON.stringify(file));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function load(): {
  state: PlayerState;
  activeCarId: string;
  rivalIndex: number;
} | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const file = JSON.parse(raw) as SaveFile;
    // A future version must not be parsed with today's shape.
    if (!file || file.version !== 1 || typeof file.state !== 'object') return null;
    return deserialise(file.state);
  } catch {
    return null;
  }
}

export function clear(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing useful to do */
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}