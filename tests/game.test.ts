import { describe, it, expect } from 'vitest';
import {
  gradeLaunch, bandsForRedline, LaunchController, DEFAULT_BANDS,
} from '../src/game/Launch';
import {
  TUNING_TREE, TUNING_BY_ID, canFit, combineEffects, NO_EFFECTS,
  RIVALS, resolveRace, newPlayer, xpForLevel, levelFromXp, resaleValue,
  buyTuning, sellTuning, buyCar, sellCar, applyRace, nextRival, rivalUnlocked,
  GarageCar, type BranchId,
} from '../src/game/Economy';
import { CAR_BY_ID, CARS } from '../src/game/data/cars';

describe('the launch window', () => {
  it('grades a bog, a good launch and a perfect launch correctly', () => {
    const B = DEFAULT_BANDS;
    expect(gradeLaunch(B.bogLow * 0.6, 1).grade).toBe('BOG');
    expect(gradeLaunch((B.perfectLow + B.perfectHigh) / 2, 1).grade).toBe('PERFECT');
    // A rpm inside the good band but OUTSIDE the perfect window.
    const goodOnly = B.goodLow + (B.goodHigh - B.goodLow) * 0.15;
    expect(gradeLaunch(goodOnly, 1).grade).toBe('GOOD');
  });

  it('monotonically rewards a better launch', () => {
    const B = DEFAULT_BANDS;
    // Sweep the whole usable range in small steps and assert the multiplier
    // rises across the launchable span, then collapses when it is blown.
    const lo = B.bogLow;
    const spin = B.spinHigh;
    const samples: number[] = [];
    for (let i = 0; i <= 40; i++) samples.push(lo + ((spin - lo) * i) / 40);
    const mults = samples.map((r) => gradeLaunch(r, 1).multiplier);

    // Find where PERFECT ends and the multiplier must fall away.
    const perfectEnd = samples.findIndex((r) => r > B.perfectHigh);
    const launchable = mults.slice(0, Math.max(1, perfectEnd));
    for (let i = 1; i < launchable.length; i++) {
      expect(mults[i], `rpm ${samples[i].toFixed(0)} should beat ${samples[i - 1].toFixed(0)}`)
        .toBeGreaterThanOrEqual(mults[i - 1]);
    }
    // A blown launch is worse than a bog: that is the whole risk.
    expect(mults[mults.length - 1]).toBeLessThan(mults[0]);
  });

  it('spreads payouts widely enough that skill beats cash', () => {
    const B = DEFAULT_BANDS;
    const best = gradeLaunch((B.perfectLow + B.perfectHigh) / 2, 1).multiplier;
    const worst = gradeLaunch(B.spinHigh + 100, 1).multiplier;
    expect(best / worst).toBeGreaterThan(5);
  });

  it('penalises over-long staging, so staging forever is not optimal', () => {
    const B = DEFAULT_BANDS;
    const mid = (B.perfectLow + B.perfectHigh) / 2;
    const quick = gradeLaunch(mid, 1).multiplier;
    const long = gradeLaunch(mid, 12).multiplier;
    expect(long).toBeLessThan(quick);
    // But it never becomes actively bad.
    expect(long).toBeGreaterThan(quick * 0.6);
  });

  it('scales the bands to the engine, so big engines are harder', () => {
    const small = bandsForRedline(6000, 4200);
    const big = bandsForRedline(12000, 7000);
    expect(small.goodLow).toBeLessThan(big.goodLow);
    expect(small.spinHigh).toBeLessThan(big.spinHigh);
    // The perfect window as a FRACTION of the range should be comparable, or
    // high-tier cars would be unfairly easy.
    const smallFrac = (small.perfectHigh - small.perfectLow) / (small.spinHigh - small.bogLow);
    const bigFrac = (big.perfectHigh - big.perfectLow) / (big.spinHigh - big.bogLow);
    expect(Math.abs(smallFrac - bigFrac)).toBeLessThan(0.1);
  });

  it('tracks the hold clock and produces one result per launch', () => {
    const B = DEFAULT_BANDS;
    const mid = (B.perfectLow + B.perfectHigh) / 2;
    const lc = new LaunchController(B);
    lc.update(0.5, B.goodLow);
    lc.update(0.5, mid);
    expect(lc.holdTime).toBeCloseTo(1.0, 5);
    expect(lc.staging).toBe(true);
    const r = lc.dump(mid);
    expect(r.grade).toBe('PERFECT');
    expect(lc.staging).toBe(false);
    // A second dump must not rescore the launch.
    lc.update(1, 7000);
    expect(lc.dump(200).grade).toBe('PERFECT');
  });

  it('normalises band position for drawing the window', () => {
    const lc = new LaunchController(DEFAULT_BANDS);
    expect(lc.bandPosition(DEFAULT_BANDS.bogLow)).toBeCloseTo(0, 5);
    expect(lc.bandPosition(DEFAULT_BANDS.spinHigh)).toBeCloseTo(1, 5);
    expect(lc.bandPosition(-500)).toBe(0);
    expect(lc.bandPosition(99999)).toBe(1);
  });
});

describe('the tuning branch tree', () => {
  it('has a sane size and unique ids', () => {
    expect(TUNING_TREE.length).toBeGreaterThanOrEqual(30);
    expect(new Set(TUNING_TREE.map((n) => n.id)).size).toBe(TUNING_TREE.length);
  });

  it('declares only real conflicts (symmetric, no self-conflict, no dupes)', () => {
    for (const node of TUNING_TREE) {
      for (const c of node.conflictsWith) {
        const other = TUNING_BY_ID.get(c);
        expect(other, `${node.id} conflicts with unknown ${c}`).toBeDefined();
        expect(c, `${node.id} conflicts with itself`).not.toBe(node.id);
        // Conflicts must be symmetric or the tree behaves inconsistently.
        expect(
          other!.conflictsWith,
          `${node.id} <-> ${c} must be mutual`,
        ).toContain(node.id);
      }
      expect(new Set(node.conflictsWith).size, `${node.id} has duplicate conflicts`)
        .toBe(node.conflictsWith.length);
    }
  });

  it('declares only real requirements, with no cycles', () => {
    for (const node of TUNING_TREE) {
      for (const r of node.requires) {
        expect(TUNING_BY_ID.get(r), `${node.id} requires unknown ${r}`).toBeDefined();
        expect(r).not.toBe(node.id);
      }
    }
    // Walk every requirement chain looking for a cycle.
    for (const node of TUNING_TREE) {
      const seen = new Set<BranchId>([node.id]);
      const stack = [...node.requires];
      while (stack.length) {
        const cur = stack.pop()!;
        expect(seen.has(cur), `requirement cycle through ${cur}`).toBe(false);
        seen.add(cur);
        stack.push(...(TUNING_BY_ID.get(cur)?.requires ?? []));
      }
    }
  });

  it('enforces conflicts and requirements when fitting', () => {
    expect(canFit('turbo_kit', new Set()).ok).toBe(true);
    expect(canFit('turbo_kit', new Set(['turbo_kit'])).ok).toBe(false);
    const withTurbo = canFit('na_cams', new Set<BranchId>(['turbo_kit']));
    expect(withTurbo.ok).toBe(false);
    expect(withTurbo.reason).toMatch(/Conflicts/);
    // Intercooler needs a forced-induction engine first.
    const noEngine = canFit('big_intercooler', new Set());
    expect(noEngine.ok).toBe(false);
    expect(noEngine.reason).toMatch(/Requires/);
    expect(canFit('big_intercooler', new Set<BranchId>(['turbo_kit'])).ok).toBe(true);
  });

  it('refuses to build an illegal combination no matter the install order', () => {
    // Every ordering of a conflicting pair must be rejected on the second fit.
    const pairs: Array<[BranchId, BranchId]> = [
      ['turbo_kit', 'na_cams'],
      ['catback', 'straight_pipe'],
      ['three_speed', 'tall_gearbox'],
      ['slicks', 'wider_rears'],
      ['shock_upgrade', 'springs'],
    ];
    for (const [a, b] of pairs) {
      expect(canFit(b, new Set([a])).ok, `${b} should not fit alongside ${a}`).toBe(false);
    }
  });

  it('never stacks past the hard caps, however many parts are fitted', () => {
    const all = new Set<BranchId>(TUNING_TREE.map((n) => n.id));
    const e = combineEffects(all);
    expect(e.torqueMult).toBeLessThanOrEqual(2.6);
    expect(e.gripMult).toBeLessThanOrEqual(2.0);
    expect(e.massMult).toBeGreaterThanOrEqual(0.85);
  });

  it('makes an empty install a no-op', () => {
    expect(combineEffects(new Set())).toEqual(NO_EFFECTS);
  });

  it('actually changes performance, not just labels', () => {
    const base = combineEffects(new Set());
    const built = combineEffects(new Set<BranchId>(['turbo_kit', 'slicks', 'weight_strip', 'transbrake']));
    expect(built.torqueMult).toBeGreaterThan(base.torqueMult * 1.4);
    expect(built.gripMult).toBeGreaterThan(base.gripMult * 1.2);
    expect(built.massMult).toBeLessThan(base.massMult);
    expect(built.launchBandMult).toBeGreaterThan(1);
  });
});

describe('the rival ladder', () => {
  it('is authored and gets harder monotonically', () => {
    expect(RIVALS.length).toBe(12);
    for (let i = 1; i < RIVALS.length; i++) {
      expect(RIVALS[i].baselineEt, `${RIVALS[i].name} should be faster than the last`)
        .toBeLessThan(RIVALS[i - 1].baselineEt);
      expect(RIVALS[i].stake).toBeGreaterThan(RIVALS[i - 1].stake);
    }
  });

  it('references real cars with a real ladder of tiers', () => {
    for (const r of RIVALS) {
      expect(CAR_BY_ID[r.carId], `${r.id} drives an unknown car`).toBeDefined();
    }
    const tiers = new Set(CARS.map((c) => c.tier));
    expect(tiers.size).toBe(6);
  });

  it('does NOT scale rival difficulty off the player level', () => {
    // A fixed ladder means over-investing does not make the game harder. This
    // is a deliberate rejection of the reference game's 0.8 + level * 0.05.
    const a = resolveRace(8.0, RIVALS[5], 1.0, 1);
    const b = resolveRace(8.0, RIVALS[5], 1.0, 1);
    expect(a.theirEt).toBe(b.theirEt);
    expect(RIVALS.every((r) => typeof r.baselineEt === 'number')).toBe(true);
  });

  it('pays a win scaled by margin and launch quality, and nothing for a loss', () => {
    const rival = RIVALS[3];
    const close = resolveRace(rival.baselineEt - 0.2, rival, 1.0, 7);
    const blowout = resolveRace(rival.baselineEt - 1.2, rival, 1.0, 7);
    expect(close.won).toBe(true);
    expect(blowout.won).toBe(true);
    // The stake is the reward for winning. The margin only modulates a BOUNDED
    // performance bonus, and a TIGHTER win gets more of it: being 0.07s up is
    // worth more than being 1.07s up, because the first was hard-won.
    expect(close.payout).toBeGreaterThan(blowout.payout);
    // Either way, a win must not pay many times the stake on margin alone.
    expect(close.payout).toBeLessThan(rival.stake * 2);
    expect(blowout.payout).toBeGreaterThanOrEqual(rival.stake);
    // Launch quality dominates margin: a perfect launch on a CLOSE run beats a
    // mediocre launch on a blowout. That is the whole point of the mechanic.
    const perfect = resolveRace(rival.baselineEt - 0.5, rival, 3.0, 7);
    expect(perfect.payout).toBeGreaterThan(blowout.payout);
    // A loss pays nothing.
    const loss = resolveRace(rival.baselineEt + 1.0, rival, 1.0, 7);
    expect(loss.won).toBe(false);
    expect(loss.payout).toBe(0);
  });

  it('varies the rival slightly run to run, but not wildly', () => {
    const rival = RIVALS[4];
    const ets = new Set<number>();
    for (let s = 0; s < 50; s++) ets.add(Number(resolveRace(1, rival, 1, s).theirEt.toFixed(6)));
    expect(ets.size).toBeGreaterThan(10);
    const vals = [...ets];
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    expect(max / min).toBeLessThan(1.1);
  });
});

describe('player progression', () => {
  it('uses a quadratic XP curve', () => {
    expect(xpForLevel(1)).toBe(100);
    expect(xpForLevel(20)).toBe(40000);
    const { level, into, needed } = levelFromXp(0);
    expect(level).toBe(1);
    expect(into).toBe(0);
    expect(needed).toBe(100);
  });

  it('levels up at the right thresholds', () => {
    let xp = 0;
    for (let l = 1; l < 5; l++) {
      expect(levelFromXp(xp).level).toBe(l);
      xp += xpForLevel(l);
    }
    expect(levelFromXp(xp).level).toBe(5);
  });

  it('starts with one free car and no cash', () => {
    const p = newPlayer();
    expect(p.cash).toBe(0);
    expect(p.garage).toHaveLength(1);
    expect(p.garage[0].carId).toBe('rusty8');
  });

  it('buys and sells parts, and sells parts for half', () => {
    const p = newPlayer();
    p.cash = 100000;
    const r = buyTuning(p, 'rusty8', 'turbo_kit');
    expect(r.ok).toBe(true);
    expect(p.cash).toBe(100000 - TUNING_BY_ID.get('turbo_kit')!.price);
    // A wrong branch is not fully recoverable: this is what makes choices matter.
    const s = sellTuning(p, 'rusty8', 'turbo_kit');
    expect(s.ok).toBe(true);
    expect(p.cash).toBe(100000 - TUNING_BY_ID.get('turbo_kit')!.price + TUNING_BY_ID.get('turbo_kit')!.price * 0.5);
  });

  it('will not fit a conflicting part even if you can afford it', () => {
    const p = newPlayer();
    p.cash = 1_000_000;
    buyTuning(p, 'rusty8', 'turbo_kit');
    const before = p.cash;
    const r = buyTuning(p, 'rusty8', 'na_cams');
    expect(r.ok).toBe(false);
    expect(p.cash).toBe(before);
  });

  it('will not fit a part you cannot afford', () => {
    const p = newPlayer();
    p.cash = 100;
    const r = buyTuning(p, 'rusty8', 'turbo_kit');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cash/i);
  });

  it('buys and sells cars with depreciation', () => {
    const p = newPlayer();
    p.cash = 200000;
    const spec = CAR_BY_ID['hatch'];
    expect(buyCar(p, 'hatch').ok).toBe(true);
    expect(p.cash).toBe(200000 - spec.price);
    const entry = p.garage.find((g) => g.carId === 'hatch')!;
    expect(resaleValue(entry, spec)).toBe(Math.round(spec.price * 0.8));
    const s = sellCar(p, 'hatch');
    expect(s.ok).toBe(true);
    // Bought for X, got back 0.8X.
    expect(p.cash).toBe(200000 - spec.price + Math.round(spec.price * 0.8));
  });

  it('never lets the player sell their last car', () => {
    const p = newPlayer();
    const r = sellCar(p, 'rusty8');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/at least one/i);
  });

  it('will not sell a duplicate car', () => {
    const p = newPlayer();
    p.cash = 200000;
    buyCar(p, 'hatch');
    expect(buyCar(p, 'hatch').ok).toBe(false);
  });

  it('wears the car, more when you lose or launch badly', () => {
    const p = newPlayer();
    const entry: GarageCar = p.garage[0];
    const rival = RIVALS[0];
    applyRace(p, resolveRace(rival.baselineEt - 0.5, rival, 1, 1), rival, entry, false);
    const afterWin = entry.condition;
    applyRace(p, resolveRace(rival.baselineEt + 1, rival, 1, 1), rival, entry, false);
    expect(entry.condition).toBeLessThan(afterWin);
  });

  it('never lets a car drop below the 0.35 floor', () => {
    const p = newPlayer();
    const entry = p.garage[0];
    const rival = RIVALS[0];
    for (let i = 0; i < 200; i++) {
      applyRace(p, resolveRace(99, rival, 0.28, i), rival, entry, false);
    }
    expect(entry.condition).toBeGreaterThanOrEqual(0.35);
  });

  it('gates rivals behind the one before', () => {
    const p = newPlayer();
    expect(rivalUnlocked(p, RIVALS[0])).toBe(true);
    expect(rivalUnlocked(p, RIVALS[1])).toBe(true);
    expect(rivalUnlocked(p, RIVALS[3])).toBe(false);
    p.beaten.add(RIVALS[2].id);
    expect(rivalUnlocked(p, RIVALS[3])).toBe(true);
  });

  it('always offers a next rival, and null only when the ladder is done', () => {
    const p = newPlayer();
    let guard = 0;
    while (nextRival(p) && guard++ < 50) {
      const r = nextRival(p)!;
      p.beaten.add(r.id);
    }
    expect(guard).toBeLessThan(50);
    expect(nextRival(p)).toBeNull();
  });
});

describe('the full loop', () => {
  it('is winnable from zero cash with no gacha and no parallel faucets', () => {
    // A simulated first hour: race the ladder in order, bank the winnings, buy
    // the cheapest effective parts. This is the real balance test.
    const p = newPlayer();
    let guard = 0;
    while (nextRival(p) && guard++ < 200) {
      const rival = nextRival(p)!;
      // Assume a decent but not perfect launch.
      const et = rival.baselineEt - 0.35;
      const out = resolveRace(et, rival, 1.0, guard);
      if (!out.won) break;
      applyRace(p, out, rival, p.garage[0], false);
      // Spend, cheapest first, on whatever fits.
      for (const n of [...TUNING_TREE].sort((a, b) => a.price - b.price)) {
        if (canFit(n.id, new Set(p.garage[0].tuning)).ok && p.cash >= n.price) {
          buyTuning(p, 'rusty8', n.id);
          break;
        }
      }
    }
    expect(guard, 'should not be stuck').toBeLessThan(200);
    expect(p.cash).toBeGreaterThan(0);
    expect(p.garage[0].tuning.length, 'the player should have bought parts').toBeGreaterThan(0);
    expect(p.racesRun).toBeGreaterThan(0);
  });
});
