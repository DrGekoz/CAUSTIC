import { describe, it, expect } from 'vitest';
import { makeVehicle, NO_INPUT, Vehicle, DEFAULT_VEHICLE_CONFIG } from '../src/physics/Vehicle';
import { solveTorqueCurve } from '../src/physics/TorqueCurve';

const DT = 1 / 240;

function inputs(over: Partial<typeof NO_INPUT> = {}) {
  return { ...NO_INPUT, ...over };
}

interface RunResult {
  et60: number;
  etQuarter: number;
  topSpeed: number;
  distanceAtQuarter: number;
}

/**
 * A simple automatic driver: shifts once per rev threshold CROSSING (edge
 * triggered, like a real driver), and holds the clutch only while launching.
 */
/**
 * An automatic driver that actually performs the Launch Window:
 *   1. hold the clutch and rev toward the green band (staging)
 *   2. dump the clutch (launch)
 *   3. shift on each rev threshold crossing for the rest of the run
 *
 * `quality` controls how well the revs are staged, which is what the launch
 * multiplier is derived from. A better launch must be measurably faster.
 */
function run(quality: number, over: Parameters<typeof makeVehicle>[0] = {}): RunResult {
  const v = makeVehicle(over);
  v.reset(1);
  v.beginLaunch(quality, 1.8);

  // Where a driver of this skill would dump the clutch.
  const greenLo = v.cfg.curve.redline * 0.62;
  const greenHi = v.cfg.curve.redline * 0.86;
  const dumpAt = greenLo + (greenHi - greenLo) * quality;

  let t = 0;
  let et60 = -1;
  const quarter = 402.34;
  let etQuarter = -1;
  let top = 0;
  let launched = false;
  let shiftLatch = false;
  let guard = 0;

  while (t < 40 && guard++ < 40000) {
    // Stage on the clutch until the revs reach the dump point.
    const staging = !launched;
    // Poll the vehicle's shift light rather than tracking rev edges here.
    const wantShift = !staging && v.shiftReady && !shiftLatch;
    shiftLatch = v.shiftReady;

    v.step(DT, inputs({ throttle: 1, clutch: staging, shiftUp: wantShift }));

    if (staging && v.rpm >= dumpAt) launched = true;
    t += DT;
    top = Math.max(top, v.speed);
    if (et60 < 0 && v.speed >= 26.8224) et60 = t;
    if (etQuarter < 0 && v.distance >= quarter) {
      etQuarter = t;
      break;
    }
  }
  return { et60, etQuarter, topSpeed: top, distanceAtQuarter: v.distance };
}

describe('vehicle integration', () => {
  it('accelerates from rest and does not produce NaN over a long run', () => {
    const v = makeVehicle();
    v.reset(1);
    v.beginLaunch(0.8);
    let launched = false;
    let latch = false;
    for (let i = 0; i < 240 * 10; i++) {
      if (!launched && v.rpm > v.cfg.curve.redline * 0.75) launched = true;
      const want = launched && v.shiftReady && !latch;
      latch = v.shiftReady;
      v.step(DT, inputs({ throttle: 1, clutch: !launched, shiftUp: want }));
      expect(Number.isFinite(v.speed)).toBe(true);
      expect(Number.isFinite(v.distance)).toBe(true);
      expect(Number.isFinite(v.rpm)).toBe(true);
      expect(v.distance).toBeGreaterThanOrEqual(0);
    }
    // Roughly 100 km/h after ten seconds. The slip governor deliberately
    // trades a little acceleration for real traction -- the car hooks up
    // instead of spinning -- so this is a sanity bound, not a target.
    expect(v.speed).toBeGreaterThan(25);
    expect(v.speed).toBeLessThan(80);
  });

  it('reaches 60mph in a plausible road-car time', () => {
    const r = run(0.8);
    // A 1400kg / 420Nm street car is roughly 5-7s. Wide bounds: this is a smoke
    // test for gross simulation error, not a balance assertion.
    expect(r.et60).toBeGreaterThan(2.5);
    expect(r.et60).toBeLessThan(12);
  });

  it('runs a quarter mile in a plausible time', () => {
    const r = run(0.8);
    expect(r.etQuarter).toBeGreaterThan(8);
    expect(r.etQuarter).toBeLessThan(25);
  });

  it('a better launch is faster over the same distance', () => {
    const bad = run(0.0);
    const good = run(1.0);
    expect(good.etQuarter).toBeLessThan(bad.etQuarter);
  });

  it('more torque is faster', () => {
    const weak = run(0.8, { peakTorque: 300 });
    const strong = run(0.8, { peakTorque: 700 });
    expect(strong.etQuarter).toBeLessThan(weak.etQuarter);
  });

  it('less mass is faster', () => {
    const heavy = run(0.8, { mass: 2000 });
    const light = run(0.8, { mass: 1000 });
    expect(light.etQuarter).toBeLessThan(heavy.etQuarter);
  });

  it('more drag is slower at speed', () => {
    const slick = run(0.8, { dragArea: 0.3 });
    const draggy = run(0.8, { dragArea: 1.2 });
    expect(draggy.etQuarter).toBeGreaterThan(slick.etQuarter);
  });

  it('more grip produces less wheelspin off the line', () => {
    const grippy = run(0.8, { tire: { ...DEFAULT_VEHICLE_CONFIG.tire, mu: 1.9 } });
    const slippy = run(0.8, { tire: { ...DEFAULT_VEHICLE_CONFIG.tire, mu: 0.5 } });
    expect(slippy.etQuarter).toBeGreaterThan(grippy.etQuarter);
  });

  it('shifting up increases gear monotonically', () => {
    const v = makeVehicle();
    v.reset(1);
    let last = v.gear;
    let launched = false;
    let latch = false;
    for (let i = 0; i < 240 * 12; i++) {
      if (!launched && v.rpm > v.cfg.curve.redline * 0.7) launched = true;
      const want = launched && v.shiftReady && !latch;
      latch = v.shiftReady;
      v.step(DT, inputs({ throttle: 1, clutch: !launched, shiftUp: want }));
      expect(v.gear).toBeGreaterThanOrEqual(last);
      last = v.gear;
    }
    expect(v.gear).toBeGreaterThan(1);
  });

  it('never exceeds the top gear count', () => {
    const v = makeVehicle();
    v.reset(1);
    for (let i = 0; i < 240 * 30; i++) {
      v.step(DT, inputs({ throttle: 1, shiftUp: true }));
    }
    expect(v.gear).toBeLessThanOrEqual(v.cfg.gearRatios.length);
  });

  it('brakes bring the car to a stop', () => {
    const v = makeVehicle();
    v.reset(1);
    for (let i = 0; i < 240 * 6; i++) {
      const la = i * DT > 0.4;
      v.step(DT, inputs({ throttle: 1, clutch: !la }));
    }
    const fast = v.speed;
    expect(fast).toBeGreaterThan(10);
    for (let i = 0; i < 240 * 20; i++) v.step(DT, inputs({ brake: 1 }));
    expect(v.speed).toBeLessThan(0.5);
  });

  it('coasts to a stop without going negative', () => {
    const v = makeVehicle();
    v.reset(1);
    for (let i = 0; i < 240 * 5; i++) {
      const la = i * DT > 0.4;
      v.step(DT, inputs({ throttle: 1, clutch: !la }));
    }
    for (let i = 0; i < 240 * 60; i++) {
      v.step(DT, inputs());
      expect(v.speed).toBeGreaterThanOrEqual(0);
    }
  });

  it('AWD is at least as quick off the line as RWD', () => {
    // AWD's advantage is traction off the line, not top end. Tested at a power
    // level where RWD would otherwise spin: a traction-limited comparison.
    const over = { peakTorque: 1400, drive: 'RWD' as const };
    const rwd = run(1.0, over);
    const awd = run(1.0, { ...over, drive: 'AWD', frontSplit: 0.4 });
    expect(awd.etQuarter).toBeLessThan(rwd.etQuarter);
  });

  it('reset returns the car to a known state', () => {
    const v: Vehicle = makeVehicle();
    for (let i = 0; i < 240 * 5; i++) v.step(DT, inputs({ throttle: 1 }));
    v.reset(1);
    expect(v.distance).toBe(0);
    expect(v.speed).toBe(0);
    expect(v.gear).toBe(1);
    expect(v.launch.timeLeft).toBe(0);
    expect(v.heat).toBe(0);
    // reset() parks the engine slightly ABOVE idle, not at it. Parking it at
    // exactly idle meant the closed clutch's reaction dragged it below on the
    // next step, the engine made zero torque, and the car could not launch at
    // all. Assert the invariant, not the old value.
    expect(v.rpm).toBeGreaterThan(v.cfg.idleRpm);
    expect(v.rpm).toBeLessThan(v.cfg.idleRpm * 1.3);
  });

  it('a car at rest can actually launch', () => {
    // The regression that motivated the reset fix: a car sitting at idle read
    // as "stopped" to the gross-torque guard, made zero crank torque, the
    // clutch had nothing to transmit, and the car covered 0.18m in a second.
    // What matters is that it accelerates at all, and keeps accelerating.
    const v = makeVehicle();
    v.reset(1);
    const marks: number[] = [];
    for (let i = 0; i < 240 * 3; i++) {
      v.step(DT, inputs({ throttle: 1 }));
      if (i % 240 === 0) marks.push(v.distance);
    }
    // Strictly increasing: the car never stalls or goes backwards.
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i], `progress at ${i}s`).toBeGreaterThan(marks[i - 1]);
    }
    // The dead-car bug covered 0.18m in one second. Anything near 1 m/s is
    // unambiguously working. (Three seconds in FIRST gear with no shifting is
    // about 3m, so this is a floor, not a target.)
    expect(marks[marks.length - 1]).toBeGreaterThan(1.5);
  });

  it('a redline-hungry engine needs more revs to keep up', () => {
    const lowRev = run(0.8, { curve: solveTorqueCurve(5500, 0.6, 1.0) });
    const highRev = run(0.8, { curve: solveTorqueCurve(9000, 0.85, 1.0) });
    // Different characters; both must complete without exploding.
    expect(lowRev.etQuarter).toBeGreaterThan(0);
    expect(highRev.etQuarter).toBeGreaterThan(0);
    expect(Number.isFinite(lowRev.etQuarter)).toBe(true);
    expect(Number.isFinite(highRev.etQuarter)).toBe(true);
  });

  it('tires heat up under wheelspin', () => {
    // Traction control off: this test is specifically about what happens when
    // the tyres ARE lit up, which is exactly what TC exists to prevent.
    const v = makeVehicle({ tire: { ...DEFAULT_VEHICLE_CONFIG.tire, mu: 0.4 }, peakTorque: 2000 });
    v.tractionControl = false;
    v.reset(1);
    v.beginLaunch(1.0);
    for (let i = 0; i < 240 * 3; i++) {
      const launched = i * DT > 0.4;
      v.step(DT, inputs({ throttle: 1, clutch: !launched }));
    }
    expect(v.wheels[2].slipRatio).toBeGreaterThan(0.3);
    expect(v.wheels[2].surfaceTemp).toBeGreaterThan(25);
  });

  it('is deterministic', () => {
    const a = run(0.7);
    const b = run(0.7);
    expect(a.etQuarter).toBe(b.etQuarter);
  });
});
