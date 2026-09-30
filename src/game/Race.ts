/**
 * The race.
 *
 * Owns one head-to-head run: two cars, a stage sequence, beam crossings and a
 * finish. ET is measured the way a real drag race measures it -- from the
 * moment each car breaks the beam to when it breaks it again -- so a bad
 * launch genuinely costs time instead of reducing a score at the end.
 *
 * Each lane keeps its OWN clock. A shared timer would hand the faster car a
 * free head start, because it would start counting before the other car moved.
 */

import { Vehicle, NO_INPUT, type VehicleConfig } from '../physics/Vehicle';
import { toVehicleConfig, type CarSpec } from '../geometry/Car';
import { gradeLaunch, bandsForRedline, type LaunchResult, type LaunchBands } from './Launch';
import { combineEffects, type BranchId } from './Economy';

export const QUARTER_MILE_M = 402.34;

/** Beam positions, in metres from the start line. */
const BEAM_SIXTY = 18.288; // 60 ft
const BEAM_330 = 100.584; // 330 ft
const BEAM_QUARTER = QUARTER_MILE_M;

export type RacePhase = 'IDLE' | 'STAGING' | 'COUNTDOWN' | 'RACING' | 'FINISHED' | 'FOUL';

export interface RaceInput {
  throttle: number;
  brake: number;
  /** True while the clutch is held during staging. */
  clutch: boolean;
  shiftUp: boolean;
  shiftDown: boolean;
  /** Release the clutch -- this is the launch. */
  launch: boolean;
  /** true = the car manages its own clutch once the race starts. */
  autoClutch: boolean;
}

export const NO_RACE_INPUT: RaceInput = {
  throttle: 0,
  brake: 0,
  clutch: false,
  shiftUp: false,
  shiftDown: false,
  launch: false,
  autoClutch: true,
};

export interface LaneTiming {
  /** 60ft, 330ft and 1320ft times in seconds. 0 means not yet reached. */
  sixty: number;
  threeThirty: number;
  et: number;
  topSpeed: number;
  launch: LaunchResult | null;
  /** Peak driven-wheel slip ratio seen. */
  peakSlip: number;
}

export interface RaceSnapshot {
  phase: RacePhase;
  countdown: number;
  playerDistance: number;
  rivalDistance: number;
  playerSpeed: number;
  rivalSpeed: number;
  playerRpm: number;
  playerGear: number;
  bands: LaunchBands;
  stageTime: number;
  bandPosition: number;
  playerTiming: LaneTiming;
  rivalTiming: LaneTiming;
  winner: 'player' | 'rival' | 'draw' | null;
  foul: string | null;
}

interface Lane {
  vehicle: Vehicle;
  timing: LaneTiming;
  finished: boolean;
  /** Per-lane clock, starts when this car first moves. */
  clock: number;
  running: boolean;
  /** Distance this lane covers before the clock starts (a rolling start). */
  startOffset: number;
  /**
   * The rpm this lane is holding on the staging line, 0 when none was chosen.
   * A real driver feathers the throttle to hold their launch rpm through the
   * lights; without this the countdown revs past the target and every launch
   * grades BLOWN.
   */
  targetRpm: number;
}

function emptyTiming(): LaneTiming {
  return { sixty: 0, threeThirty: 0, et: 0, topSpeed: 0, launch: null, peakSlip: 0 };
}

/** Apply a tuning set to a car spec, producing a vehicle config. */
export function configForTuning(spec: CarSpec, tuning: ReadonlySet<BranchId>): VehicleConfig {
  const e = combineEffects(tuning);
  return toVehicleConfig(spec, {
    torqueMult: e.torqueMult,
    gripMult: e.gripMult,
    massMult: e.massMult,
    redlineBonus: e.redlineBonus,
  });
}

/** The launch bands for a vehicle's engine. */
export function bandsFor(v: Vehicle): LaunchBands {
  return bandsForRedline(v.cfg.curve.redline, v.cfg.curve.peakRpm);
}

/**
 * A rival's driving, expressed as a quality rather than as raw input, so the AI
 * is tunable in one number. `skill` 0..1 decides launch timing and shift points.
 */
export interface RivalDrive {
  /** Target launch rpm as a fraction of redline. */
  launchFraction: number;
  /** How long they hold the clutch, seconds. */
  holdTime: number;
  /** Shift at this fraction of redline. */
  shiftFraction: number;
  /** Reaction delay before they go, seconds. */
  reaction: number;
  /** Throttle discipline, 0.6..1. */
  throttle: number;
}

export const RIVAL_DRIVES: RivalDrive[] = [
  // An ascending ladder: early rivals launch badly, the top ones are quick.
  { launchFraction: 0.30, holdTime: 3.2, shiftFraction: 0.80, reaction: 0.42, throttle: 0.72 },
  { launchFraction: 0.38, holdTime: 2.6, shiftFraction: 0.84, reaction: 0.34, throttle: 0.80 },
  { launchFraction: 0.44, holdTime: 2.2, shiftFraction: 0.88, reaction: 0.28, throttle: 0.86 },
  { launchFraction: 0.52, holdTime: 1.8, shiftFraction: 0.91, reaction: 0.22, throttle: 0.90 },
  { launchFraction: 0.58, holdTime: 1.5, shiftFraction: 0.93, reaction: 0.18, throttle: 0.94 },
  { launchFraction: 0.62, holdTime: 1.3, shiftFraction: 0.94, reaction: 0.14, throttle: 0.96 },
  { launchFraction: 0.66, holdTime: 1.1, shiftFraction: 0.95, reaction: 0.11, throttle: 0.98 },
  { launchFraction: 0.70, holdTime: 1.0, shiftFraction: 0.96, reaction: 0.09, throttle: 1.0 },
  { launchFraction: 0.72, holdTime: 0.95, shiftFraction: 0.96, reaction: 0.08, throttle: 1.0 },
  { launchFraction: 0.74, holdTime: 0.9, shiftFraction: 0.97, reaction: 0.07, throttle: 1.0 },
  { launchFraction: 0.76, holdTime: 0.85, shiftFraction: 0.97, reaction: 0.06, throttle: 1.0 },
  { launchFraction: 0.78, holdTime: 0.8, shiftFraction: 0.98, reaction: 0.05, throttle: 1.0 },
];

export class Race {
  readonly player: Lane;
  readonly rival: Lane;
  readonly rivalDrive: RivalDrive;
  phase: RacePhase = 'IDLE';
  countdown = 0;
  /** Seconds spent on the staging line. */
  stageTime = 0;
  private foulReason: string | null = null;
  private rivalStageElapsed = 0;
  private rivalLaunched = false;
  /** How long after the player launches the rival goes. */
  private rivalReactionTimer = 0;
  /** Seconds the player's clutch has been continuously released. */
  private releasedFor = 0;
  /** Whether the player has ever held the clutch, so a launch can be detected. */
  private sawClutchHeld = false;
  /** True once the player has committed, so staging cannot restart. */
  private playerCommitted = false;

  constructor(
    playerSpec: CarSpec,
    playerTuning: ReadonlySet<BranchId>,
    rivalSpec: CarSpec,
    rivalTuning: ReadonlySet<BranchId> = new Set(),
    /** Index into RIVAL_DRIVES, 0..11. */
    rivalSkill = 0,
    startOffset = 0,
  ) {
    this.player = {
      vehicle: new Vehicle(configForTuning(playerSpec, playerTuning)),
      timing: emptyTiming(),
      finished: false,
      clock: 0,
      running: false,
      startOffset,
      targetRpm: 0,
    };
    this.rival = {
      vehicle: new Vehicle(configForTuning(rivalSpec, rivalTuning)),
      timing: emptyTiming(),
      finished: false,
      clock: 0,
      running: false,
      startOffset,
      targetRpm: 0,
    };
    this.rivalDrive = RIVAL_DRIVES[Math.max(0, Math.min(RIVAL_DRIVES.length - 1, rivalSkill))];
  }

  /** Put both cars on the line. */
  begin(): void {
    // Gear 1, not 0: index 0 is REVERSE, and neutral is not how you stage a
    // drag car. reset(0) put both cars in reverse, so the launch dumped the
    // clutch into nothing and neither car ever moved.
    this.player.vehicle.reset(1);
    this.rival.vehicle.reset(1);
    this.player.timing = emptyTiming();
    this.rival.timing = emptyTiming();
    this.player.finished = false;
    this.rival.finished = false;
    this.player.clock = 0;
    this.rival.clock = 0;
    this.player.running = false;
    this.rival.running = false;
    this.stageTime = 0;
    this.countdown = 0;
    this.foulReason = null;
    this.rivalStageElapsed = 0;
    this.rivalLaunched = false;
    this.rivalReactionTimer = 0;
    this.releasedFor = 0;
    this.sawClutchHeld = false;
    this.playerCommitted = false;
    this.player.targetRpm = 0;
    this.rival.targetRpm = 0;
    this.phase = 'STAGING';
  }

  /**
   * One fixed step.
   *
   * STAGING   -- clutch in, the player builds revs. Launching ends it.
   * COUNTDOWN -- three, two, one. Throttle is cut so nobody can jump the beam.
   * RACING    -- the car drives itself unless the player took the clutch.
   */
  step(dt: number, input: RaceInput): void {
    if (this.phase === 'IDLE' || this.phase === 'FINISHED' || this.phase === 'FOUL') return;

    // A rival who was still staging when the player went has a reaction delay
    // before they launch. Decrement it here so the timer actually runs.
    if (this.rivalReactionTimer > 0) {
      this.rivalReactionTimer -= dt;
      if (this.rivalReactionTimer <= 0) this.launchRival();
    }

    switch (this.phase) {
      case 'STAGING':
        this.stepStaging(dt, input);
        break;
      case 'COUNTDOWN':
        this.stepCountdown(dt);
        break;
      case 'RACING':
        this.stepRacing(dt, input);
        break;
    }
  }

  private stepStaging(dt: number, input: RaceInput): void {
    // Once the player has committed, staging is over: a late clutch input
    // cannot drag the race back.
    if (this.playerCommitted) return;
    this.stageTime += dt;
    this.rivalStageElapsed += dt;
    if (this.rival.targetRpm === 0) {
      this.rival.targetRpm = this.rivalDrive.launchFraction * this.rival.vehicle.cfg.curve.redline;
    }

    // Player: clutch held, revs build with throttle.
    this.player.vehicle.step(dt, { ...NO_INPUT, throttle: input.throttle, clutch: true });
    // Rival: same, aiming at their own target rpm.
    const rv = this.rival.vehicle;
    const rb = bandsFor(rv);
    const target = this.rivalDrive.launchFraction * rv.cfg.curve.redline;
    const revErr = target - rv.rpm;
    this.rival.vehicle.step(dt, {
      ...NO_INPUT,
      throttle: this.rival.targetRpm > 0
        ? Math.max(0, Math.min(1, revErr / 900))
        : Math.max(0, Math.min(1, revErr / 900)),
      clutch: true,
    });
    void rb;

    // A launch needs a SUSTAINED clutch release. A single frame with
    // clutch=false -- a blip on the clutch, or a dropped input frame -- used to
    // launch the car at whatever revs it happened to be sitting at, which made
    // the staging target meaningless.
    if (!input.clutch) this.releasedFor += dt;
    else this.releasedFor = 0;
    this.sawClutchHeld ||= input.clutch;

    const playerLaunched = input.launch;
    const playerLetGo = this.sawClutchHeld && this.releasedFor > 0.15;
    const rivalReady = this.rivalStageElapsed >= this.rivalDrive.holdTime;

    // The rival being ready does NOT end the player's staging. Both cars stage
    // independently, exactly as they do on a real strip, and the tree sends
    // both at the same instant. Letting a ready rival flip the phase cancelled
    // the player's launch, discarded their staged revs, and scored every launch
    // at the limiter.
    if (rivalReady && !this.rivalLaunched) {
      this.rivalLaunched = true;
      const rv = this.rival.vehicle;
      this.rival.timing.launch = gradeLaunch(rv.rpm, this.rivalStageElapsed, bandsFor(rv));
      this.rival.targetRpm = rv.rpm;
    }

    // Hold-up timer. A player who never touches the controls must not stage
    // forever; the strip gives up on them and sends them.
    if (this.stageTime > 10) {
      const v0 = this.player.vehicle;
      this.player.timing.launch = gradeLaunch(v0.rpm, this.stageTime, bandsFor(v0));
      this.player.targetRpm = v0.rpm;
      this.playerCommitted = true;
      this.phase = 'COUNTDOWN';
      this.countdown = 3;
      this.rivalReactionTimer = this.rivalDrive.reaction;
      if (!this.rivalLaunched) {
        this.rivalLaunched = true;
        const rv0 = this.rival.vehicle;
        this.rival.timing.launch = gradeLaunch(rv0.rpm, this.rivalStageElapsed, bandsFor(rv0));
        this.rival.targetRpm = rv0.rpm;
      }
      return;
    }

    if (playerLaunched || playerLetGo) {
      // The player commits. The rival goes on their own reaction time, which is
      // the whole point: a slow player can be beaten off the line by a quick
      // rival, and a quick player can beat a slow one.
      const v = this.player.vehicle;
      this.player.timing.launch = gradeLaunch(v.rpm, this.stageTime, bandsFor(v));
      this.player.targetRpm = v.rpm;
      this.playerCommitted = true;
      this.phase = 'COUNTDOWN';
      this.countdown = 3;
      this.rivalReactionTimer = this.rivalLaunched
        ? this.rivalDrive.reaction
        : this.rivalDrive.reaction;
    }
  }

  /**
   * The lights went out. Grade the launch from the revs the player actually
   * held to the line, and hand that quality to the physics.
   */
  private commitLaunch(lane: Lane, holdTime: number): void {
    const v = lane.vehicle;
    let result = lane.timing.launch;
    if (!result) {
      // A rival who never staged a launch (the player went first and the
      // rival was still holding) is scored from whatever they had.
      result = gradeLaunch(v.rpm, holdTime, bandsFor(v));
      lane.timing.launch = result;
    }
    // Map the payout multiplier back onto 0..1 for the physics, which turns it
    // into real grip, torque and a torque floor for the first 1.8s.
    const q = Math.max(0, Math.min(1, (result.multiplier - 0.28) / (3.125 - 0.28)));
    v.beginLaunch(q);
  }

  private launchRival(): void {
    if (this.rivalLaunched) return;
    this.rivalLaunched = true;
    const rv = this.rival.vehicle;
    this.rival.timing.launch = gradeLaunch(rv.rpm, this.rivalStageElapsed, bandsFor(rv));
    this.rival.targetRpm = rv.rpm;
  }

  private stepCountdown(dt: number): void {
    this.countdown -= dt;
    // Hold the car on the clutch WITH the throttle down, which is how a drag
    // car is actually staged. Two earlier versions got this wrong: braking
    // (which stops the auto-clutch from opening at zero speed) and then
    // releasing to zero throttle, both of which bled the staged revs away and
    // launched the car from idle. The player holds the revs they paid for.
    this.player.vehicle.step(dt, {
      ...NO_INPUT,
      clutch: true,
      throttle: this.holdThrottle(this.player, 1, dt),
    });
    this.rival.vehicle.step(dt, {
      ...NO_INPUT,
      clutch: true,
      throttle: this.holdThrottle(this.rival, 1, dt),
    });
    if (this.countdown <= 0) {
      this.phase = 'RACING';
      this.countdown = 0;
      // The green light: this is the moment the launch is scored.
      this.commitLaunch(this.player, this.stageTime);
      this.commitLaunch(this.rival, this.rivalStageElapsed);
    }
  }

  /**
   * Throttle needed to HOLD a rev target with the clutch in. Pinning full
   * throttle just revs the engine past the target and straight into the blown
   * band, so a player who staged a perfect launch had it thrown away by the
   * countdown. Real drivers feather it; this does the same.
   */
  private holdThrottle(lane: Lane, max: number, dt: number): number {
    const v = lane.vehicle;
    const target = lane.targetRpm;
    if (target <= 0) return max;
    const err = target - v.rpm;
    // 500 rpm of error maps to full throttle, so it settles rather than
    // oscillating. Above target this returns zero, which is NOT enough: with
    // the clutch in, zero throttle still let the revs climb to the limiter, so
    // every launch drifted to the limiter and graded BLOWN regardless of what
    // the player staged to. Past the target, brake the engine instead.
    if (err < 0) {
      const over = -err;
      v.engineOmega -= Math.min(over / 260, 1) * 1.6 * dt;
      return 0;
    }
    return Math.max(0, Math.min(max, err / 500));
  }

  private stepRacing(dt: number, input: RaceInput): void {
    this.player.vehicle.step(dt, {
      ...NO_INPUT,
      throttle: input.throttle,
      brake: input.brake,
      clutch: input.autoClutch ? false : input.clutch,
      shiftUp: input.shiftUp,
      shiftDown: input.shiftDown,
    });

    const rv = this.rival.vehicle;
    this.rival.vehicle.step(dt, {
      ...NO_INPUT,
      throttle: this.rivalDrive.throttle,
      shiftUp:
        rv.rpm > this.rivalDrive.shiftFraction * rv.cfg.curve.redline && rv.shiftReady,
    });

    this.updateTiming(dt);

    if ((this.player.finished && this.rival.finished) || this.timedOut()) {
      this.phase = 'FINISHED';
    }
  }

  private timedOut(): boolean {
    return this.player.clock > 40 || this.rival.clock > 40;
  }

  /** Per-lane beam timing. Each clock starts when that car first moves. */
  private updateTiming(dt: number): void {
    for (const lane of [this.player, this.rival]) {
      const v = lane.vehicle;
      const t = lane.timing;

      if (!lane.running && Math.abs(v.speed) > 0.5) {
        lane.running = true;
      }
      if (lane.running) lane.clock += dt;

      for (const w of v.wheels) {
        const slip = Math.abs(w.slipRatio);
        if (slip > t.peakSlip) t.peakSlip = slip;
      }
      const spd = Math.abs(v.speed);
      if (spd > t.topSpeed) t.topSpeed = spd;

      if (lane.finished) continue;
      const at = v.distance - lane.startOffset;
      if (t.sixty === 0 && at >= BEAM_SIXTY) t.sixty = lane.clock;
      if (t.threeThirty === 0 && at >= BEAM_330) t.threeThirty = lane.clock;
      if (t.et === 0 && at >= BEAM_QUARTER) {
        t.et = lane.clock;
        lane.finished = true;
      }
    }
  }

  /** Who won, once the race is over. */
  winner(): 'player' | 'rival' | 'draw' | null {
    if (this.phase !== 'FINISHED' && this.phase !== 'FOUL') return null;
    const p = this.player.timing.et;
    const r = this.rival.timing.et;
    if (p === 0 && r === 0) return this.timedOut() ? 'draw' : null;
    if (p === 0) return 'rival';
    if (r === 0) return 'player';
    if (Math.abs(p - r) < 0.005) return 'draw';
    return p < r ? 'player' : 'rival';
  }

  get foul(): string | null {
    return this.foulReason;
  }

  /** True once the race has produced a result for both lanes. */
  get complete(): boolean {
    return this.phase === 'FINISHED' || this.phase === 'FOUL';
  }

  snapshot(): RaceSnapshot {
    const v = this.player.vehicle;
    const bands = bandsFor(v);
    const lo = bands.bogLow;
    const hi = bands.spinHigh;
    return {
      phase: this.phase,
      countdown: Math.max(0, this.countdown),
      playerDistance: this.player.vehicle.distance - this.player.startOffset,
      rivalDistance: this.rival.vehicle.distance - this.rival.startOffset,
      playerSpeed: this.player.vehicle.speed,
      rivalSpeed: this.rival.vehicle.speed,
      playerRpm: v.rpm,
      playerGear: v.gear,
      bands,
      stageTime: this.stageTime,
      bandPosition: Math.max(0, Math.min(1, (v.rpm - lo) / Math.max(1, hi - lo))),
      playerTiming: this.player.timing,
      rivalTiming: this.rival.timing,
      winner: this.winner(),
      foul: this.foulReason,
    };
  }
}
