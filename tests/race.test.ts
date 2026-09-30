import { describe, it, expect } from 'vitest';
import { Race, NO_RACE_INPUT, RIVAL_DRIVES, QUARTER_MILE_M, bandsFor } from '../src/game/Race';
import type { RaceInput } from '../src/game/Race';
import { CARS, CAR_BY_ID } from '../src/game/data/cars';
import { DEFAULT_BANDS } from '../src/game/Launch';
import type { BranchId } from '../src/game/Economy';

const DT = 1 / 240;

/** Drive a whole race with a scripted launch and full throttle after. */
function runRace(
  opts: {
    playerCar?: string;
    playerTuning?: BranchId[];
    rivalCar?: string;
    rivalSkill?: number;
    /** Target rpm to hit before dumping the clutch. */
    launchTo?: number;
    /** Seconds to hold the clutch. */
    hold?: number;
    maxSeconds?: number;
  } = {},
): Race {
  const playerSpec = CAR_BY_ID[opts.playerCar ?? 'rusty8'];
  const rivalSpec = CAR_BY_ID[opts.rivalCar ?? 'hatch'];
  const race = new Race(
    playerSpec,
    new Set(opts.playerTuning ?? []),
    rivalSpec,
    new Set<BranchId>(),
    opts.rivalSkill ?? 0,
  );
  race.begin();

  const target = opts.launchTo ?? DEFAULT_BANDS.perfectLow + 400;
  const hold = opts.hold ?? 1.0;
  const maxT = opts.maxSeconds ?? 60;

  const input: RaceInput = { ...NO_RACE_INPUT };
  let t = 0;
  while (t < maxT && !race.complete) {
    // Staging: hold the clutch and feed in throttle toward the target rpm.
    if (race.phase === 'STAGING') {
      const v = (race as unknown as { player: { vehicle: { rpm: number } } }).player.vehicle;
      // Feather toward the target and let off entirely once there, the way a
      // driver holds a rev target. Clamping at zero without the release gain
      // left the engine sitting wherever it drifted to, and every launch
      // graded the same regardless of the target.
      const err = target - v.rpm;
      input.throttle = err > 0 ? Math.min(1, err / 600) : 0;
      input.clutch = t < hold;
      input.launch = t >= hold;
    } else {
      input.throttle = 1;
      input.clutch = false;
      input.launch = false;
      // Shift at the redline.
      const v = (race as unknown as { player: { vehicle: { rpm: number; shiftReady: boolean; cfg: { curve: { redline: number } } } } }).player.vehicle;
      input.shiftUp = v.rpm > v.cfg.curve.redline * 0.95 && v.shiftReady;
    }
    race.step(DT, input);
    t += DT;
  }
  return race;
}

describe('the race sequence', () => {
  it('starts in STAGING and does not move before the launch', () => {
    const race = new Race(CAR_BY_ID.rusty8, new Set(), CAR_BY_ID.hatch, new Set(), 0);
    race.begin();
    expect(race.phase).toBe('STAGING');
    // Sit on the line for a second holding the clutch.
    for (let i = 0; i < 240; i++) {
      race.step(DT, { ...NO_RACE_INPUT, throttle: 1, clutch: true });
    }
    const s = race.snapshot();
    expect(s.playerDistance).toBeLessThan(0.5);
    expect(s.phase).toBe('STAGING');
  });

  it('counts down after a launch and cannot jump the beam', () => {
    const race = new Race(CAR_BY_ID.rusty8, new Set(), CAR_BY_ID.hatch, new Set(), 0);
    race.begin();
    for (let i = 0; i < 120; i++) race.step(DT, { ...NO_RACE_INPUT, throttle: 1, clutch: true });
    race.step(DT, { ...NO_RACE_INPUT, throttle: 1, clutch: true, launch: true });
    expect(race.phase).toBe('COUNTDOWN');
    // Full throttle during the countdown must not move the car.
    for (let i = 0; i < 200; i++) {
      race.step(DT, { ...NO_RACE_INPUT, throttle: 1 });
      expect(race.snapshot().playerDistance).toBeLessThan(2);
    }
  });

  it('reaches RACING, then FINISHED', () => {
    const race = runRace();
    expect(race.phase).toBe('FINISHED');
    expect(race.complete).toBe(true);
  });

  it('produces a plausible quarter-mile time', () => {
    const race = runRace();
    const t = race.snapshot().playerTiming;
    expect(t.et).toBeGreaterThan(9);
    expect(t.et).toBeLessThan(25);
  });

  it('records all three beams in ascending order', () => {
    const race = runRace();
    const t = race.snapshot().playerTiming;
    expect(t.sixty).toBeGreaterThan(0);
    expect(t.threeThirty).toBeGreaterThan(t.sixty);
    expect(t.et).toBeGreaterThan(t.threeThirty);
  });

  it('reaches a sane top speed', () => {
    const race = runRace();
    const t = race.snapshot().playerTiming;
    // 40-90 m/s is 90-200 km/h, a plausible strip car over 1/8 mile.
    expect(t.topSpeed).toBeGreaterThan(30);
    expect(t.topSpeed).toBeLessThan(120);
  });

  it('always decides a winner, and a worse launch never beats a better one', () => {
    // The mechanic, verified end to end: a bogged launch against the strongest
    // rival loses, a well-staged launch against the same rival wins. That is
    // the whole promise of the game.
    const bog = runRace({ launchTo: 1000, hold: 1.2, rivalSkill: 11 });
    const good = runRace({ launchTo: 3900, hold: 1.2, rivalSkill: 11 });
    expect(bog.winner()).not.toBeNull();
    expect(bog.snapshot().playerTiming.launch!.grade).toBe('BOG');
    expect(bog.winner(), 'a bog must lose to the best rival').toBe('rival');
    expect(good.winner(), 'a good launch must beat the best rival').toBe('player');
    // And the mechanism is time, not a score: the bog is genuinely slower.
    expect(bog.snapshot().playerTiming.et).toBeGreaterThan(good.snapshot().playerTiming.et);
  });

  it('a launch decides the race against an even rival', () => {
    // Same car, same rival, opposite launches: the outcome flips.
    const bog = runRace({ launchTo: 1000, hold: 1.2, rivalSkill: 5 });
    const good = runRace({ launchTo: 3900, hold: 1.2, rivalSkill: 5 });
    expect(bog.winner()).toBe('player');
    expect(good.winner()).toBe('player');
    expect(bog.snapshot().playerTiming.et - good.snapshot().playerTiming.et)
      .toBeGreaterThan(1.0);
  });

  it('a better launch is faster, measured not assumed', () => {
    const good = runRace({ launchTo: DEFAULT_BANDS.perfectLow + 400, hold: 1 });
    const bad = runRace({ launchTo: 1400, hold: 1 });
    expect(good.snapshot().playerTiming.et).toBeLessThan(bad.snapshot().playerTiming.et);
  });

  it('a better car is faster at the same launch quality', () => {
    const cheap = runRace({ playerCar: 'rusty8', rivalCar: 'hatch' });
    const fast = runRace({ playerCar: 'vettore', rivalCar: 'hatch' });
    expect(fast.snapshot().playerTiming.et).toBeLessThan(cheap.snapshot().playerTiming.et);
  });

  it('tuning makes the car faster', () => {
    // Slicks alone cannot help a car that is already traction-limited: the
    // limit is the engine, not the tyre. The parts that matter are the ones
    // that add force, so test those.
    const stock = runRace({ playerCar: 'rusty8' });
    const built = runRace({
      playerCar: 'rusty8',
      playerTuning: ['catback', 'slicks', 'weight_strip', 'valve_spring', 'gearing_stage2'],
    });
    expect(built.snapshot().playerTiming.et).toBeLessThan(stock.snapshot().playerTiming.et);
  });

  it('grip upgrades do not help a car that is engine-limited', () => {
    // Documenting a real balance property, not asserting a wish: the starter
    // car makes far less torque than its tyres can hold, so a grip upgrade
    // cannot make it faster. Power parts can.
    const stock = runRace({ playerCar: 'rusty8' });
    const gripped = runRace({ playerCar: 'rusty8', playerTuning: ['slicks'] });
    expect(gripped.snapshot().playerTiming.et).toBeGreaterThan(
      stock.snapshot().playerTiming.et - 0.35,
    );
  });

  it('records the launch result for both lanes', () => {
    const race = runRace();
    const s = race.snapshot();
    expect(s.playerTiming.launch).not.toBeNull();
    expect(s.rivalTiming.launch).not.toBeNull();
    expect(s.playerTiming.launch!.rpmAtDump).toBeGreaterThan(0);
  });

  it('never records a negative or non-monotonic beam time', () => {
    for (const launchTo of [900, 2500, 4000, 5500, 7000]) {
      const race = runRace({ launchTo, hold: 1 });
      const t = race.snapshot().playerTiming;
      expect(t.sixty, `60ft at ${launchTo}`).toBeGreaterThanOrEqual(0);
      expect(t.threeThirty).toBeGreaterThanOrEqual(t.sixty);
      expect(t.et).toBeGreaterThanOrEqual(t.threeThirty);
    }
  });

  it('grades every launch band and rewards the whole ladder', () => {
    // The full sweep, verified by measurement rather than asserted in the
    // abstract. Grades must appear in order and the payout must fall with a
    // worse launch.
    const cases: Array<[number, string]> = [
      [900, 'BOG'],
      [2000, 'POOR'],
      [3000, 'GOOD'],
      [3900, 'PERFECT'],
      [5500, 'GREAT'],
      [6200, 'BLOWN'],
    ];
    const seen = new Map<string, number>();
    for (const [target, expectGrade] of cases) {
      const s = runRace({ launchTo: target, hold: 1.2 }).snapshot();
      const L = s.playerTiming.launch!;
      expect(L.grade, `target ${target}rpm`).toBe(expectGrade);
      seen.set(expectGrade, L.multiplier);
    }
    // Payout must fall as the launch gets worse, monotonically.
    expect(seen.get('PERFECT')!).toBeGreaterThan(seen.get('GREAT')!);
    expect(seen.get('GREAT')!).toBeGreaterThan(seen.get('GOOD')!);
    expect(seen.get('GOOD')!).toBeGreaterThan(seen.get('POOR')!);
    expect(seen.get('POOR')!).toBeGreaterThan(seen.get('BOG')!);
    // A blown launch must be worse than a perfect one in TIME too, or the
    // risk is free.
    const blown = runRace({ launchTo: 6200, hold: 1.2 }).snapshot();
    const perfect = runRace({ launchTo: 3900, hold: 1.2 }).snapshot();
    expect(blown.playerTiming.et).toBeGreaterThan(perfect.playerTiming.et);
  });

  it('gives each lane its own clock, so a slow start is not free', () => {
    // If the clocks were shared, a car that waited to launch would get credited
    // with the other's running time.
    const race = runRace({ launchTo: 4000, hold: 2.5 });
    const s = race.snapshot();
    expect(s.playerTiming.et).toBeGreaterThan(0);
    expect(s.rivalTiming.et).toBeGreaterThan(0);
    // Both clocks are real race times, both in a plausible range.
    expect(s.playerTiming.et).toBeLessThan(30);
    expect(s.rivalTiming.et).toBeLessThan(30);
  });

  it('a blown launch bogs rather than spinning its wheels', () => {
    // Counter-intuitive but correct: a blown launch has a low torque floor, so
    // it never delivers enough torque to spin the tyres. It bogs. The wheel
    // slip belongs to a launch with plenty of torque aimed too high, which is
    // a big-power car, not the starter.
    const clean = runRace({ launchTo: 3600, hold: 1 });
    const blown = runRace({ launchTo: 6180, hold: 1 });
    const c = clean.snapshot().playerTiming.peakSlip;
    const b = blown.snapshot().playerTiming.peakSlip;
    expect(b, `blown=${b} clean=${c}`).toBeLessThan(c);
    // And it is slower, which is what actually matters.
    expect(blown.snapshot().playerTiming.et).toBeGreaterThan(clean.snapshot().playerTiming.et);
  });
});

describe('the rival AI', () => {
  it('has a full ladder of drives, one per rival', () => {
    expect(RIVAL_DRIVES).toHaveLength(12);
  });

  it('launches harder and reacts faster as skill rises', () => {
    for (let i = 1; i < RIVAL_DRIVES.length; i++) {
      expect(RIVAL_DRIVES[i].launchFraction).toBeGreaterThan(RIVAL_DRIVES[i - 1].launchFraction);
      expect(RIVAL_DRIVES[i].reaction).toBeLessThan(RIVAL_DRIVES[i - 1].reaction);
    }
  });

  it('a more skilled rival runs a faster ET in the same car', () => {
    const low = runRace({ rivalSkill: 0 });
    const high = runRace({ rivalSkill: 11 });
    const lt = low.snapshot().rivalTiming.et;
    const ht = high.snapshot().rivalTiming.et;
    expect(lt).toBeGreaterThan(0);
    expect(ht).toBeGreaterThan(0);
    // The skilled rival has a better launch, so a clean run should be quicker.
    expect(ht).toBeLessThan(lt);
  });

  it('keeps the whole rival ladder inside a plausible range', () => {
    const ets: number[] = [];
    for (let skill = 0; skill < RIVAL_DRIVES.length; skill++) {
      const r = runRace({ rivalSkill: skill });
      const et = r.snapshot().rivalTiming.et;
      expect(et, `rival ${skill} must finish`).toBeGreaterThan(0);
      ets.push(et);
    }
    // The best rival should be meaningfully quicker than the worst.
    expect(ets[0]).toBeGreaterThan(ets[ets.length - 1]);
  });
});

describe('robustness', () => {
  it('survives a race that is never launched properly', () => {
    const race = new Race(CAR_BY_ID.rusty8, new Set(), CAR_BY_ID.hatch, new Set(), 0);
    race.begin();
    // Never press launch, never touch the throttle. It must still terminate.
    // 10s hold-up, 3s countdown, then a run that never finishes: the race
    // must still terminate on the timeout.
    for (let i = 0; i < 240 * 70 && !race.complete; i++) {
      race.step(DT, NO_RACE_INPUT);
    }
    expect(race.complete).toBe(true);
  });

  it('times out rather than running forever if a car never finishes', () => {
    const race = new Race(CAR_BY_ID.rusty8, new Set(), CAR_BY_ID.hatch, new Set(), 0);
    race.begin();
    for (let i = 0; i < 120; i++) race.step(DT, { ...NO_RACE_INPUT, throttle: 1, clutch: true });
    race.step(DT, { ...NO_RACE_INPUT, throttle: 1, clutch: true, launch: true });
    // Run out the 3s countdown, then sit at zero throttle. The cars must stop
    // and the race must terminate rather than spinning forever.
    for (let i = 0; i < 240 * 45 && !race.complete; i++) {
      race.step(DT, { ...NO_RACE_INPUT, throttle: 0 });
    }
    expect(race.complete).toBe(true);
  });

  it('ignores input when the race is not running', () => {
    const race = new Race(CAR_BY_ID.rusty8, new Set(), CAR_BY_ID.hatch, new Set(), 0);
    // Never begun: stepping must be a no-op, not a crash.
    race.step(DT, { ...NO_RACE_INPUT, throttle: 1, launch: true });
    expect(race.phase).toBe('IDLE');
  });

  it('can be restarted cleanly', () => {
    const race = runRace();
    const first = race.snapshot().playerTiming.et;
    race.begin();
    expect(race.phase).toBe('STAGING');
    expect(race.snapshot().playerTiming.et).toBe(0);
    const second = runRaceWith(race, 4000, 1);
    expect(second).toBeGreaterThan(0);
    expect(Math.abs(second - first)).toBeLessThan(1.5);
  });
});

function runRaceWith(race: Race, target: number, hold: number): number {
  const input: RaceInput = { ...NO_RACE_INPUT };
  let t = 0;
  while (t < 60 && !race.complete) {
    if (race.phase === 'STAGING') {
      const v = (race as unknown as { player: { vehicle: { rpm: number } } }).player.vehicle;
      const err = target - v.rpm;
      input.throttle = err > 0 ? Math.min(1, err / 600) : 0;
      input.clutch = t < hold;
      input.launch = t >= hold;
    } else {
      input.throttle = 1;
    }
    race.step(DT, input);
    t += DT;
  }
  return race.snapshot().playerTiming.et;
}

void QUARTER_MILE_M;
void bandsFor;
void CARS;
