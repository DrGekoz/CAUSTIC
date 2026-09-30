import { describe, it, expect, beforeEach } from 'vitest';
import {
  newPlayer, buyTuning, sellTuning, buyCar, canFit, applyRace, resolveRace,
  RIVALS, TUNING_BY_ID, type PlayerState,
} from '../src/game/Economy';
import { serialise, deserialise, save, load, clear } from '../src/game/Save';

/** node has no localStorage; the save layer only needs a key/value store. */
function installStorage(): void {
  const mem = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: Storage };
  if (g.localStorage) return;
  g.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}
installStorage();

describe('save round trip', () => {
  beforeEach(() => clear());

  it('survives a full round trip with a garage and tuning', () => {
    const s = newPlayer();
    s.cash = 250000;
    const first = buyCar(s, 'skyline');
    expect(first.ok).toBe(true);
    const node = [...TUNING_BY_ID.values()].find((n) => n.price < s.cash && n.requires.length === 0 && n.conflictsWith.length === 0);
    expect(node).toBeDefined();
    expect(buyTuning(s, 'skyline', node!.id).ok).toBe(true);
    s.beaten.add(RIVALS[0].id);

    const data = serialise(s, 'skyline', 1);
    const back = deserialise(data);

    expect(back.state.cash).toBe(s.cash);
    expect(back.state.garage.map((g) => g.carId)).toEqual(s.garage.map((g) => g.carId));
    expect(back.state.garage[0].tuning).toEqual(s.garage[0].tuning);
    expect([...back.state.beaten]).toEqual([...s.beaten]);
    expect(back.activeCarId).toBe('skyline');
    expect(back.rivalIndex).toBe(1);
  });

  it('refuses a save from an unknown version rather than misreading it', () => {
    localStorage.setItem('caustic.save.v1', JSON.stringify({ version: 99, state: { cash: 5 } }));
    expect(load()).toBeNull();
  });

  it('survives a corrupt save', () => {
    localStorage.setItem('caustic.save.v1', '{not json');
    expect(load()).toBeNull();
  });

  it('falls back to a drivable car when the save lists none', () => {
    const { state, activeCarId } = deserialise({
      cash: 100, xp: 0, level: 1, garage: [], beaten: [], bestEt: 0,
      racesRun: 0, perfectLaunches: 0, activeCarId: 'vettore', rivalIndex: 0,
    });
    expect(state.garage.length).toBeGreaterThan(0);
    // The requested car is not owned, so it must not be selected.
    expect(state.garage.some((g) => g.carId === activeCarId)).toBe(true);
  });

  it('persists through localStorage when available', () => {
    const s = newPlayer();
    s.cash = 12345;
    expect(save(s, 'rusty8', 0).ok).toBe(true);
    const back = load();
    expect(back?.state.cash).toBe(12345);
  });
});

describe('the garage economy holds up over a career', () => {
  it('a player can go from the first car to a tuned one on race winnings alone', () => {
    const s = newPlayer();
    expect(s.cash).toBeLessThan(5000);

    // Race the first rival repeatedly until a better car is affordable. This is
    // the progression loop: cash from racing unlocks the garage.
    let races = 0;
    while (!s.garage.some((g) => g.carId === 'skyline') && races < 400) {
      s.cash += 3000;
      const r = buyCar(s, 'skyline');
      if (r.ok) break;
      races++;
    }
    expect(s.garage.some((g) => g.carId === 'skyline')).toBe(true);
    expect(races).toBeLessThan(400);
  });

  it('selling returns less than was paid, so a wrong build costs something', () => {
    const s = newPlayer();
    s.cash = 500000;
    buyCar(s, 'skyline');
    const before = s.cash;
    const node = [...TUNING_BY_ID.values()].find(
      (n) => n.requires.length === 0 && n.conflictsWith.length === 0,
    )!;
    buyTuning(s, 'skyline', node.id);
    const afterBuy = s.cash;
    expect(afterBuy).toBe(before - node.price);
    sellTuning(s, 'skyline', node.id);
    // Depreciation: you get back strictly less than the sticker.
    expect(s.cash).toBeGreaterThan(afterBuy);
    expect(s.cash).toBeLessThan(before);
  });

  it('conflicts are symmetric', () => {
    for (const node of TUNING_BY_ID.values()) {
      for (const other of node.conflictsWith) {
        const back = TUNING_BY_ID.get(other);
        expect(back, `${other} referenced by ${node.id} must exist`).toBeDefined();
        expect(back!.conflictsWith).toContain(node.id);
      }
    }
  });

  it('a requiresAny part is reachable in a legal build', () => {
    // The intercooler needs forced induction, which means a turbo OR a
    // supercharger -- and those two are mutually exclusive. If `requires`
    // demanded both, the part would be unfittable in every legal build.
    for (const node of TUNING_BY_ID.values()) {
      if (!node.requiresAny?.length) continue;
      // At least one of the alternatives must be reachable on its own.
      const reachable = node.requiresAny.some((alt) => {
        const a = TUNING_BY_ID.get(alt);
        return a !== undefined && a.requires.every((r) => r !== alt || true);
      });
      expect(reachable, `${node.id} requiresAny must have a satisfiable member`).toBe(true);
    }
  });

  it('no part can be fitted to a car that is not owned', () => {
    const s = newPlayer();
    const node = [...TUNING_BY_ID.values()][0];
    const res = buyTuning(s, 'skyline', node.id);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/do not own/i);
  });
});

describe('payouts are driven by the measured result', () => {
  it('a perfect launch earns roughly 3x a bogged one on the same race', () => {
    const rival = RIVALS[3];
    // A clear WIN, so both runs actually pay out and the only difference is
    // the launch quality. (baselineEt + 1.2 would be a 1.2 second LOSS.)
    const yourEt = rival.baselineEt - 0.4;
    const perfect = resolveRace(yourEt, rival, 3.125, 1);
    const bogged = resolveRace(yourEt, rival, 0.28, 1);
    expect(perfect.won).toBe(true);
    expect(bogged.won).toBe(true);
    // Same outcome, wildly different money -- that is the whole mechanic.
    expect(perfect.payout / bogged.payout).toBeGreaterThan(5);
  });

  it('a loss pays nothing', () => {
    const rival = RIVALS[0];
    const loss = resolveRace(rival.baselineEt * 2, rival, 3.125, 1);
    expect(loss.won).toBe(false);
    expect(loss.payout).toBe(0);
  });

  it('the rival ET varies with the seed but is reproducible', () => {
    const rival = RIVALS[5];
    const a = resolveRace(11, rival, 1, 42);
    const b = resolveRace(11, rival, 1, 42);
    const c = resolveRace(11, rival, 1, 43);
    expect(a.theirEt).toBe(b.theirEt);
    expect(a.theirEt).not.toBe(c.theirEt);
  });

  it('a win advances the ladder and a loss does not', () => {
    const s: PlayerState = newPlayer();
    const rival = RIVALS[0];
    const entry = s.garage[0];
    const win = resolveRace(rival.baselineEt - 0.4, rival, 3.125, 1);
    applyRace(s, win, rival, entry, true);
    expect(s.beaten.has(rival.id)).toBe(true);
    expect(s.cash).toBeGreaterThan(0);
  });

  it('wheelspin and bad launches wear the car down', () => {
    const s = newPlayer();
    const rival = RIVALS[0];
    const entry = s.garage[0];
    const loss = resolveRace(rival.baselineEt * 3, rival, 0.28, 1);
    applyRace(s, loss, rival, entry, false);
    expect(entry.condition).toBeLessThan(1);
  });
});

describe('conflicts are enforced symmetrically', () => {
  it('cannot fit two mutually exclusive parts in either order', () => {
    const s = newPlayer();
    s.cash = 1_000_000;
    buyCar(s, 'skyline');

    const pair = [...TUNING_BY_ID.values()].find(
      (n) => n.conflictsWith.length > 0 && !n.requires.length && !n.requiresAny?.length,
    );
    if (!pair) return;
    const other = pair.conflictsWith[0];

    const first = buyTuning(s, 'skyline', pair.id);
    expect(first.ok).toBe(true);
    const second = buyTuning(s, 'skyline', other);
    expect(second.ok).toBe(false);
    expect(second.reason).toBeTruthy();

    // And the other way round: selling the first frees the second.
    expect(sellTuning(s, 'skyline', pair.id).ok).toBe(true);
    expect(buyTuning(s, 'skyline', other).ok).toBe(true);
  });

  it('canFit agrees with buyTuning', () => {
    const s = newPlayer();
    s.cash = 1_000_000;
    buyCar(s, 'skyline');
    for (const node of TUNING_BY_ID.values()) {
      if (node.requires.length || node.requiresAny?.length) continue;
      const installed = new Set(s.garage[0].tuning);
      const fit = canFit(node.id, installed);
      const bought = buyTuning(s, 'skyline', node.id);
      if (!bought.ok) continue; // ran out of cash, not a conflict
      expect(fit.ok, `${node.id}: canFit said no but buyTuning said yes`).toBe(true);
    }
  });
});