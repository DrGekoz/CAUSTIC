/**
 * Vehicle dynamics.
 *
 * A longitudinal-plus-load-transfer model. Drag racing is a straight line, so
 * lateral dynamics only matter through weight transfer; full tyre slip IS
 * simulated per wheel because that is what makes wheelspin, bogging and the
 * launch multiplier physically real rather than a fudge factor.
 *
 * Fixed timestep, accumulator-driven, decoupled from render.
 */

import { TorqueCurve, efficiencyAt } from './TorqueCurve';
import { TireParams, combinedForce, tyreSlope, DEFAULT_TIRE } from './Tire';

export const GRAVITY = 9.81; // m/s^2
export const AIR_DENSITY = 1.225; // kg/m^3
export const WHEEL_RADIUS = 0.33; // ~26in overall
export const WHEEL_INERTIA = 1.35; // kg m^2 per wheel+hub+brake
/** Clutch slip stiffness, N*m per rad/s. See updateDrivetrain for the stability bound. */
const CLUTCH_STIFFNESS = 45;
/** Bearing and scrub damping, Nm per rad/s. Damps the wheel/tyre oscillator. */
const WHEEL_DAMPING = 6;
/**
 * Fraction of the redline the engine must still be above in the next gear for
 * an up-shift to be worth making. Below this the shift bogs the engine out of
 * its power band.
 */
const SHIFT_FLOOR = 0.55;

export interface WheelState {
  /** Normal load, newtons. */
  load: number;
  /** Slip ratio. */
  slipRatio: number;
  /** Slip angle, radians. */
  slipAngle: number;
  /** Wheel angular velocity, rad/s. */
  omega: number;
  /** Longitudinal force this step, newtons. */
  fx: number;
  /** Surface temperature, celsius. */
  surfaceTemp: number;
  /** Longitudinal slip speed, m/s (drives smoke + audio). */
  slipSpeed: number;
  /** Reaction torque from the tyre on the wheel, Nm. */
  torqueReaction: number;
  /** Brake torque acting on the wheel, Nm. */
  brakeTorque: number;
  /** Lateral force, N. */
  lateral: number;
}

export type DriveLayout = 'RWD' | 'FWD' | 'AWD';

export interface VehicleConfig {
  mass: number;
  /** Peak engine torque, Nm. */
  peakTorque: number;
  curve: TorqueCurve;
  idleRpm: number;
  /** index 0 = reverse, 1..N = forward. */
  gearRatios: number[];
  finalDrive: number;
  drivetrainEfficiency: number;
  tire: TireParams;
  /** Cd*A, m^2. */
  dragArea: number;
  /** Downforce, newtons per (m/s)^2. */
  downforce: number;
  rollingResistance: number;
  wheelbase: number;
  cgHeight: number;
  trackWidth: number;
  /** Static front weight fraction, 0..1. */
  frontWeightBias: number;
  /** Peak brake torque at the wheel, Nm. */
  brakeTorque: number;
  drive: DriveLayout;
  /** AWD torque split to the front axle, 0..1. */
  frontSplit: number;
  /** Engine + flywheel rotational inertia, kg m^2. */
  engineInertia: number;
  /** Torque-cut duration of a shift, seconds. */
  shiftTime: number;
}

export const DEFAULT_VEHICLE_CONFIG: VehicleConfig = {
  mass: 1400,
  peakTorque: 420,
  curve: { p: 0.78, a: 0.55, c: 0.35, m: 1.4, redline: 7000, peakRpm: 5460 },
  idleRpm: 850,
  // Sane gearing for 420Nm. 1st gear total = 2.20 * 3.30 = 7.26:1, which puts
  // ~3050 Nm on the axle -- still enough to light up a street tyre, but within
  // a factor of 2 of what the tyre can hold, so it spins and recovers instead
  // of running away. Earlier values (3.55 x 3.9 = 13.8:1) put 5700 Nm on the
  // axle, which no tyre can hold and which pinned the slip at the clamp for
  // the entire run.
  gearRatios: [2.2, 1.55, 1.2, 1.0, 0.85, 0.72],
  finalDrive: 3.3,
  drivetrainEfficiency: 0.9,
  tire: DEFAULT_TIRE,
  dragArea: 0.72,
  downforce: 0.9,
  rollingResistance: 0.014,
  wheelbase: 2.6,
  cgHeight: 0.48,
  trackWidth: 1.6,
  frontWeightBias: 0.53,
  brakeTorque: 4200,
  drive: 'RWD',
  frontSplit: 0,
  engineInertia: 0.22,
  shiftTime: 0.12,
};

export type ShiftState =
  | 'idle'
  | 'revving'
  | 'staged'
  | 'shifting'
  | 'launching'
  | 'running'
  | 'done';

export interface VehicleInputs {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  shiftUp: boolean;
  shiftDown: boolean;
  clutch: boolean;
}

export const NO_INPUT: VehicleInputs = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  shiftUp: false,
  shiftDown: false,
  clutch: false,
};

export interface LaunchModifiers {
  /** Tyre grip multiplier from launch quality, 0.78..1.33. */
  traction: number;
  /** Engine torque multiplier from launch quality, 0.86..1.25. */
  torque: number;
  /**
   * Hard ceiling on crank torque DURING the launch window, as a fraction of
   * peak. A bogged launch cannot deliver much torque at all; a perfect one has
   * no ceiling. This is what makes the mechanic matter on a power-limited car
   * rather than only on a grip-limited one.
   */
  torqueFloor: number;
  /** Seconds of launch window remaining. */
  timeLeft: number;
}

export class Vehicle {
  cfg: VehicleConfig;
  distance = 0;
  speed = 0;
  lateralSpeed = 0;
  yawRate = 0;
  /** -1 reverse, 0 neutral, 1..N forward. */
  gear = 0;
  engineOmega = 0;
  shiftState: ShiftState = 'idle';
  shiftTimer = 0;
  wheels: WheelState[] = [];
  launch: LaunchModifiers = { traction: 1, torque: 1, torqueFloor: 1, timeLeft: 0 };
  /** Over-rev / wheelspin heat, 0..1. */
  heat = 0;
  finished = false;
  /** Body roll/pitch for the renderer, radians. */
  pitch = 0;
  roll = 0;
  /** Torque delivered to the driven axle, Nm. */
  axleTorque = 0;
  /** True when the clutch is closed and transmitting. */
  clutchEngaged = false;
  /** Clutch slip speed, rad/s. Drives the slip audio. */
  clutchSlip = 0;
  /**
   * True when the engine is in the shift band and the gearbox is ready for an
   * up-shift. The driver (human or automatic) polls this instead of tracking
   * rev edges itself, which is what a real shift light does.
   */
  shiftReady = false;
  /** True while the brake switch has auto-released the clutch. */
  autoClutch = false;
  /** Traction-control cut, 0..1, where 1 is full intervention. */
  /** Last commanded brake demand, 0..1. The renderer uses it for brake lights. */
  brakeInput = 0;
  tcCut = 0;
  /** 0 disables traction control entirely (drift/competition mode). */
  tractionControl = true;
  /** Set false for a bare-metal race car with no ABS. */
  absEnabled = true;
  /**
   * How much of the tyre's peak-slip torque the TC is willing to command,
   * as a fraction. 1.0 uses the whole tyre; 0.9 leaves a little headroom so
   * the launch does not sit exactly on the peak.
   */
  tcAuthority = 0.95;

  private lastAccel = 0;
  private lastLateralAccel = 0;
  /** Clutch torque computed this step, consumed by integrateEngine. */
  private clutchTorqueStep = 0;
  /** Net crank torque this step. */
  private crankStep = 0;
  /** Driven wheel indices this step, for the engine coupling. */
  private drivenForEngine: number[] = [];
  /** Sum of drive shares this step. */
  private shareTotalForEngine = 0;
  /** Diagnostics: gross crank torque and traction-limited axle torque. */
  diagGross = 0;
  diagTraction = 0;

  constructor(cfg: VehicleConfig) {
    this.cfg = cfg;
    this.wheels = [0, 1, 2, 3].map(() => ({
      load: 0,
      slipRatio: 0,
      slipAngle: 0,
      omega: 0,
      fx: 0,
      surfaceTemp: 20,
      slipSpeed: 0,
      torqueReaction: 0,
      brakeTorque: 0,
      lateral: 0,
    }));
    this.reset();
  }

  get wheelRadius(): number {
    return WHEEL_RADIUS;
  }

  /** Engine-to-wheel ratio in the current gear; 0 in neutral. */
  get totalRatio(): number {
    const g = this.gear;
    if (g === 0) return 0;
    const idx = g < 0 ? 0 : Math.min(g, this.cfg.gearRatios.length) - (g < 0 ? 0 : 1);
    const ratio = this.cfg.gearRatios[Math.max(0, idx)] ?? 0;
    const total = ratio * this.cfg.finalDrive;
    return g < 0 ? -total : total;
  }

  get rpm(): number {
    return (this.engineOmega * 60) / (2 * Math.PI);
  }

  get loadFactor(): number {
    return Math.min(1, this.rpm / this.cfg.curve.redline);
  }

  /** Largest speed this car can reach, m/s (solved from the power balance). */
  get topSpeed(): number {
    const { peakTorque, curve, drivetrainEfficiency, dragArea, rollingResistance, mass } = this.cfg;
    // Power at the wheels is roughly peakTorque * peakRpm * eff (crude but stable).
    const power = (peakTorque * curve.peakRpm * 2 * Math.PI) / 60 * drivetrainEfficiency;
    const dragK = 0.5 * AIR_DENSITY * dragArea;
    // power = dragK*v^3 + rr*mass*g*v
    let v = 5;
    for (let i = 0; i < 200; i++) {
      const need = dragK * v * v * v + rollingResistance * mass * GRAVITY * v;
      if (need >= power) break;
      v *= 1.03;
    }
    return v;
  }

  reset(gear = 0): void {
    this.distance = 0;
    this.speed = 0;
    this.lateralSpeed = 0;
    this.yawRate = 0;
    this.gear = gear;
    // A touch above idle: the closed clutch's reaction immediately drags the
    // engine down, and starting it exactly at idle means it is below idle
    // within one step.
    this.engineOmega = (this.cfg.idleRpm * 1.12 * 2 * Math.PI) / 60;
    this.shiftState = 'idle';
    this.shiftTimer = 0;
    this.heat = 0;
    this.finished = false;
    this.pitch = 0;
    this.roll = 0;
    this.lastAccel = 0;
    this.lastLateralAccel = 0;
    this.tcCut = 0;
    this.clutchSlip = this.engineOmega;
    this.launch = { traction: 1, torque: 1, torqueFloor: 1, timeLeft: 0 };
    for (const w of this.wheels) {
      w.load = 0;
      w.slipRatio = 0;
      w.slipAngle = 0;
      w.omega = 0;
      w.fx = 0;
      w.surfaceTemp = 20;
      w.slipSpeed = 0;
      w.torqueReaction = 0;
      w.brakeTorque = 0;
      w.lateral = 0;
    }
  }

  /** Open the launch window; quality 0..1. */
  /**
   * Begin the launch window with a quality in 0..1.
   *
   * Launch quality has to bite on a POWER-limited car, not just a grip-limited
   * one, or the mechanic does nothing. Multiplying torque by 0.86 for 1.8s
   * changed almost nothing on a car that was torque-bound rather than
   * traction-bound, and a bogged launch still beat a perfect one.
   *
   * So the window also carries a TORQUE FLOOR: a bad launch physically cannot
   * deliver much crank torque for its duration, which is what a bog actually
   * is -- the engine falls off the cam, the tyres hook up at idle, and the car
   * crawls. A perfect launch has no such floor.
   */
  beginLaunch(quality: number, seconds = 1.8): void {
    const q = Math.max(0, Math.min(1, quality));
    this.launch = {
      traction: 0.78 + q * 0.55,
      torque: 0.86 + q * 0.39,
      // 0.18 of peak crank torque at q=0, full torque by q=0.55. A bad launch
      // is not "a good launch, slightly worse" -- it barely drives at all.
      torqueFloor: 0.18 + Math.max(0, q - 0.1) * 1.14,
      timeLeft: seconds,
    };
    this.shiftState = 'launching';
  }

  get launchQualityNow(): number {
    if (this.launch.timeLeft <= 0) return 0;
    return (this.launch.traction - 0.78) / 0.55;
  }

  /**
   * One fixed timestep. The order below is the whole drivetrain contract; see
   * the file header for why each stage must run in this position.
   */
  step(dt: number, input: VehicleInputs): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.brakeInput = input.brake;

    this.stepShifting(dt, input);
    this.updateLoads();
    this.updateTyres(dt, input);
    this.updateDrivetrain(dt, input);
    this.integrateWheels(dt);
    this.integrateEngine(dt);
    this.integrate(dt);
    this.updateHeat(dt, input);
    this.updateBodyAttitude(dt);
    this.tickLaunch(dt);
  }

  private stepShifting(dt: number, input: VehicleInputs): void {
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) {
        this.shiftTimer = 0;
        if (this.shiftState === 'shifting') {
          this.shiftState = this.launch.timeLeft > 0 ? 'launching' : 'running';
        }
      }
    } else if (input.shiftUp && this.gear < this.cfg.gearRatios.length) {
      this.gear += 1;
      this.shiftTimer = this.cfg.shiftTime;
      this.shiftState = 'shifting';
    } else if (input.shiftDown && this.gear > 0) {
      this.gear -= 1;
      this.shiftTimer = this.cfg.shiftTime * 0.7;
      this.shiftState = 'shifting';
    }
  }

  private isDriven(i: number): boolean {
    if (this.cfg.drive === 'AWD') return true;
    if (this.cfg.drive === 'FWD') return i < 2;
    return i >= 2;
  }

  private driveShare(i: number): number {
    if (this.cfg.drive === 'AWD') return i < 2 ? this.cfg.frontSplit : 1 - this.cfg.frontSplit;
    return 1;
  }

  private drivenIndices(): number[] {
    const out: number[] = [];
    for (let i = 0; i < 4; i++) if (this.isDriven(i)) out.push(i);
    return out;
  }

  /** Static load + longitudinal transfer + downforce + lateral shuffle. */
  private updateLoads(): void {
    const { mass, wheelbase, cgHeight, trackWidth, frontWeightBias, downforce } = this.cfg;
    const total = mass * GRAVITY + downforce * this.speed * this.speed;

    const transfer = (mass * this.lastAccel * cgHeight) / wheelbase;
    const front = Math.max(0, total * frontWeightBias - transfer);
    const rear = Math.max(0, total * (1 - frontWeightBias) + transfer);

    const latTransfer = (mass * this.lastLateralAccel * cgHeight) / trackWidth;
    const hf = front / 2;
    const hr = rear / 2;

    this.wheels[0].load = Math.max(0, hf - latTransfer);
    this.wheels[1].load = Math.max(0, hf + latTransfer);
    this.wheels[2].load = Math.max(0, hr - latTransfer);
    this.wheels[3].load = Math.max(0, hr + latTransfer);
  }

  /** Slip -> tyre force -> reaction torque. Writes forces only, not speeds. */
  private updateTyres(dt: number, input: VehicleInputs): void {
    let brakeNm = (this.cfg.brakeTorque * input.brake) / WHEEL_RADIUS;

    // ABS. A locked wheel develops a POSITIVE tyre force (it slips backwards
    // relative to the road), which propels the car and leaves a residual speed
    // that brakes never remove. Real cars solve this by modulating brake
    // pressure to hold slip near the tyre's peak. Without it the car settles
    // at a crawl that no amount of brake input clears, because the tyre keeps
    // pushing back exactly as hard as the brake holds the wheel.
    if (this.absEnabled && input.brake > 0.05 && Math.abs(this.speed) > 1) {
      let worstSlip = 0;
      for (let i = 0; i < 4; i++) worstSlip = Math.min(worstSlip, this.wheels[i].slipRatio);
      if (worstSlip < -this.cfg.tire.peakSlipRatio * 1.4) {
        // Approaching lock: release pressure.
        brakeNm *= Math.max(0, 1 + worstSlip * 3.5);
      }
    }

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const isFront = i < 2;

      w.slipSpeed = w.omega * WHEEL_RADIUS - this.speed;
      w.slipRatio = Math.max(-3, Math.min(3, w.slipSpeed / Math.max(0.8, Math.abs(this.speed))));

      const halfBase = isFront ? this.cfg.wheelbase * 0.5 : -this.cfg.wheelbase * 0.5;
      const steerAngle = isFront ? input.steer * 0.42 : 0;
      const kinematic = Math.atan2(
        this.lateralSpeed + this.yawRate * halfBase,
        Math.max(1.5, Math.abs(this.speed)),
      );
      w.slipAngle = Number.isFinite(kinematic) ? kinematic - steerAngle : 0;

      let mu = this.cfg.tire.mu * this.launch.traction;
      mu *= 1 - Math.min(0.18, Math.max(0, (w.surfaceTemp - 95) / 380));
      if (input.handbrake && isFront) mu *= 0.4;

      const [fx, fy] = combinedForce({ ...this.cfg.tire, mu }, w.slipRatio, w.slipAngle, w.load);
      w.fx = fx;
      w.lateral = fy;
      // The tyre pushes back on the wheel: this is what slows a spinning wheel.
      w.torqueReaction = -fx * WHEEL_RADIUS;
      if (brakeNm > 0) {
        // A brake applies force regardless of wheel speed. Using
        // Math.sign(w.omega) gave a STOPPED wheel zero brake torque (sign(0)
        // is 0), so nothing held it: any disturbance spun it up, it developed
        // positive slip, and the tyre pushed the car forward with up to
        // 14.7 kN while the driver was on full brakes.
        const dir = w.omega !== 0 ? Math.sign(w.omega) : Math.sign(this.speed) || 1;
        w.brakeTorque = -dir * brakeNm * (isFront ? 1.0 : 0.65);
      } else {
        w.brakeTorque = 0;
      }

      const power = Math.abs(w.slipSpeed) * Math.abs(fx);
      w.surfaceTemp += (power * 0.00004 - (0.6 + this.speed * 0.05)) * dt;
      w.surfaceTemp = Math.max(15, Math.min(200, w.surfaceTemp));
    }
  }

  /**
   * Clutch, traction control and the shift light. Writes axleTorque and the
   * per-step clutch torque used by integrateEngine.
   */
  private updateDrivetrain(dt: number, input: VehicleInputs): void {
    const curve = this.cfg.curve;
    const eff = efficiencyAt(curve, this.rpm);
    const absRatio = Math.abs(this.totalRatio);
    const shifting = this.shiftTimer > 0;
    const idleOmega = (this.cfg.idleRpm * 2 * Math.PI) / 60;

    // Gross = what the engine makes. Net = gross minus internal drag.
    const friction = 12 + this.rpm * 0.0045;
    // A bad launch physically cannot deliver crank torque, on top of the
    // usual scaling. Without this the mechanic did nothing on a power-limited
    // car: scaling torque by 0.86 barely registers when the engine, not the
    // tyres, is the binding constraint, so a bogged launch still won.
    let gross = input.throttle * this.cfg.peakTorque * eff * this.launch.torque;
    if (this.launch.timeLeft > 0) {
      const launchCap = this.launch.torqueFloor * this.cfg.peakTorque;
      if (gross > launchCap) gross = launchCap;
    }
    // Only a genuinely stopped engine makes no torque. Comparing against
    // idleOmega itself meant any car sitting at idle -- which is where BOTH
    // cars sit before a drag race -- read as stopped, so the engine made zero
    // torque from the second step onward, the clutch had nothing to transmit
    // and axleTorque went to zero. No launch was ever possible.
    if (this.engineOmega < idleOmega * 0.35) gross = 0;
    const net = input.throttle < 0.02 ? -friction * 2.2 : gross - friction;

    const driven = this.drivenIndices();
    const hasDrive = driven.length > 0 && absRatio > 0.01;

    let wheelOmega = 0;
    let shareTotal = 0;
    for (const i of driven) {
      wheelOmega += this.wheels[i].omega * this.driveShare(i);
      shareTotal += this.driveShare(i);
    }
    wheelOmega = shareTotal > 0 ? wheelOmega / shareTotal : 0;

    // Clutch. Heavy braking auto-releases it, as a brake switch does.
    const autoClutchOut = input.brake > 0.4 && Math.abs(this.speed) > 0.3;
    this.autoClutch = autoClutchOut;
    const clutchOpen = input.clutch || shifting || !hasDrive || autoClutchOut;

    let clutchTorque = 0;
    if (!clutchOpen) {
      // Capacity is bounded by GROSS crank torque. Using NET crank here
      // over-transmits by the internal losses and drags the engine down at
      // roughly 460 rpm per second.
      const capacity = Math.min(
        this.cfg.peakTorque * (0.75 + input.throttle * 0.55),
        Math.max(0, gross),
      );
      clutchTorque = Math.max(-capacity, Math.min(capacity, CLUTCH_STIFFNESS * this.clutchSlip));
      if (this.engineOmega <= idleOmega && clutchTorque < 0) clutchTorque = 0;
    }
    this.clutchEngaged = !clutchOpen;
    this.clutchTorqueStep = clutchTorque;
    this.crankStep = net;
    this.drivenForEngine = driven;
    this.shareTotalForEngine = shareTotal;

    let axleTorque = clutchTorque * absRatio * this.cfg.drivetrainEfficiency;

    // Traction control. Solves for the torque that puts the tyre at its
    // peak-slip point rather than reacting to slip after the fact: a feedback
    // loop on slip oscillates between full cut and none and leaves the car
    // crawling at walking pace.
    if (this.tractionControl && !clutchOpen && hasDrive) {
      // SUM, not average. The traction limit is the total torque the driven
      // tyres can hold, so averaging over shareTotal shrinks it in proportion
      // to how many wheels are driven. That penalised AWD (four driven
      // wheels) more than RWD (two) and made an all-wheel-drive car about a
      // second slower over the quarter mile at every power level tested.
      // Dividing by shareTotal is only correct if every driven wheel carried
      // the same share of the torque, which is not what the split means.
      let tractionTorque = 0;
      for (const i of driven) {
        const mu = this.cfg.tire.mu * this.launch.traction;
        tractionTorque += mu * this.wheels[i].load * WHEEL_RADIUS * this.driveShare(i);
      }

      if (tractionTorque > 1 && absRatio > 0.01) {
        const maxEngineTorque =
          (tractionTorque / (absRatio * this.cfg.drivetrainEfficiency)) * this.tcAuthority;
        // Recomputed directly, never ratcheted. Using Math.max here made the
        // cut stick at its worst-ever value: an early step with low rear load
        // set it to 0.83 and it never recovered, because the condition that
        // lowers it (gross < maxEngineTorque) was never met again. The car
        // then accelerated at 0.4 m/s^2 with 70% of the tyre's grip unused.
        if (gross > maxEngineTorque) {
          const want = 1 - maxEngineTorque / Math.max(1, gross);
          // Rise instantly, release over ~80ms, like a real TC solenoid.
          this.tcCut = want > this.tcCut ? want : Math.max(want, this.tcCut - dt * 12);
        } else {
          this.tcCut = Math.max(0, this.tcCut - dt * 12);
        }
      } else {
        this.tcCut = Math.max(0, this.tcCut - dt * 12);
      }

      // Slip governor. The torque cap above limits how much torque reaches the
      // tyre, but it cannot stop the wheel accelerating past the peak, where
      // the magic formula produces LESS force than at peak -- more slip, less
      // grip, and the car goes nowhere while the slip ratio pins at its clamp.
      // Target the peak directly and cut on the excess. This is what makes a
      // launch settle into a chirp instead of running away.
      //
      // Only govern once the car is actually moving. A standing start is slip
      // 1.0 by definition and slip infinity for the first instant, so
      // governing from a standstill fights the launch itself: the cut hit 0.97
      // on the first step and five of twelve cars never moved at all.
      // Gate on the WHEEL, not the car. A standing start is slip 1.0 by
      // definition, so gating on car speed left the launch -- the moment slip
      // matters most -- completely ungovened. Gate on whether the driven wheel
      // is genuinely spinning faster than the road.
      const wheelSpinning = driven.some((i) => this.wheels[i].omega * WHEEL_RADIUS > Math.abs(this.speed) + 2.5);
      if (this.tractionControl && (Math.abs(this.speed) > 1.5 || wheelSpinning)) {
        const peak = Math.max(0.02, this.cfg.tire.peakSlipRatio);
        let worst = 0;
        for (const i of driven) {
          const ex = Math.abs(this.wheels[i].slipRatio) / peak;
          if (ex > worst) worst = ex;
        }
        if (worst > 1) {
          // Saturating rather than linear: past the peak the force gain falls
          // off, so a linear cut would be either far too weak or slam to zero
          // and oscillate. 1/(1+k*e) settles instead.
          const cut = 1 - 1 / (1 + (worst - 1) * 2.4);
          this.tcCut = Math.max(this.tcCut, Math.min(0.92, cut));
        }
      }

      axleTorque *= 1 - this.tcCut;
    } else {
      this.tcCut = Math.max(0, this.tcCut - dt * 6);
    }

    this.axleTorque = axleTorque;
    this.diagGross = gross;
    this.diagTraction = (() => {
      let t2 = 0;
      let st = 0;
      for (const i of driven) { t2 += this.cfg.tire.mu * this.launch.traction * this.wheels[i].load * WHEEL_RADIUS * this.driveShare(i); st += this.driveShare(i); }
      return st > 0 ? t2 / st : 0;
    })();

    // The shift light uses the rpm the GEARBOX sees, not raw engine rpm.
    // During a wheelspinning launch the engine sits on the limiter in any gear,
    // so a raw-rpm rule walks the box to top gear in two seconds.
    this.shiftReady = false;
    if (this.gear >= 1 && !shifting && !input.clutch && hasDrive) {
      const gearedRpm = ((wheelOmega * absRatio) * 60) / (2 * Math.PI);
      const nextRatio = this.cfg.gearRatios[this.gear] ?? 0;
      const curRatio = this.cfg.gearRatios[this.gear - 1] ?? 0;
      if (nextRatio > 0 && curRatio > 0) {
        const nextRpm = (gearedRpm * nextRatio) / curRatio;
        // The upper bound used to be redline * 0.995, which demanded the next
        // gear land UNDER the limiter. A drag car runs most of a pass in
        // wheelspin, where wheel speed is 3x road speed, so first gear was
        // already geared past the redline and no gear ever qualified: every
        // car spent the whole quarter in first. Allow a modest overshoot --
        // the tyres, not the engine, are the limit off the line.
        this.shiftReady =
          gearedRpm > curve.redline * 0.9 &&
          nextRpm > curve.redline * SHIFT_FLOOR &&
          nextRpm < curve.redline * 1.6;
      }
    }
  }

  /**
   * Backward Euler on the wheel equation, for every wheel. Explicit Euler is
   * violently unstable here: the tyre is stiff near zero slip (about 9800 Nm
   * per rad/s at 1.5 m/s), stable only for dt < 0.28 ms against a 4.17 ms
   * step. Observed failure: omega oscillating 0..7 rad/s every step and the
   * car crawling at 5 kph.
   */
  private integrateWheels(dt: number): void {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const driveNm = this.isDriven(i) ? this.axleTorque * this.driveShare(i) : 0;
      const k = this.tyreStiffness(i);
      const denom = WHEEL_INERTIA / dt + WHEEL_RADIUS * k + WHEEL_DAMPING;
      w.omega += (driveNm + w.brakeTorque - WHEEL_RADIUS * w.fx) / denom;
      if (w.omega < 0) w.omega = 0;
      // A braked wheel must not be spun past road speed by its own tyre
      // reaction, which would otherwise oscillate around zero.
      if (w.brakeTorque < 0 && w.omega > 0 && w.brakeTorque + WHEEL_RADIUS * w.fx < 0) {
        w.omega = 0;
      }
    }
  }

  /** Tyre slope dF/dslip in Nm per rad/s of wheel speed, for the implicit solve. */
  private tyreStiffness(i: number): number {
    const w = this.wheels[i];
    const denom = Math.max(0.8, Math.abs(this.speed));
    const dFdslip = tyreSlope(
      this.cfg.tire,
      w.slipRatio,
      w.load,
      w.surfaceTemp,
      this.launch.traction,
    );
    const k = dFdslip * (WHEEL_RADIUS / denom) * WHEEL_RADIUS;
    return Math.min(Math.max(k, 0), 4e5);
  }

  /** Engine and clutch slip advanced together from the same clutch torque. */
  private integrateEngine(dt: number): void {
    const Ie = this.cfg.engineInertia;
    const absRatio = Math.abs(this.totalRatio);
    const idleOmega = (this.cfg.idleRpm * 2 * Math.PI) / 60;

    if (!this.clutchEngaged || absRatio <= 0.01) {
      this.engineOmega += (this.crankStep / Ie) * dt;
      this.clutchSlip = this.engineOmega;
    } else {
      const dWe = (this.crankStep - this.clutchTorqueStep) / Ie;
      let wheelReaction = 0;
      for (const i of this.drivenForEngine) {
        wheelReaction +=
          (WHEEL_RADIUS * this.wheels[i].fx + this.wheels[i].brakeTorque) * this.driveShare(i);
      }
      const share = this.shareTotalForEngine;
      wheelReaction = share > 0 ? wheelReaction / share : 0;

      const dSlip =
        dWe -
        (this.clutchTorqueStep * this.cfg.drivetrainEfficiency + wheelReaction / absRatio) /
          WHEEL_INERTIA;
      this.clutchSlip += dSlip * dt;
      this.engineOmega += dWe * dt;
    }

    // Idle governor only with the clutch open. A closed clutch dragging the
    // engine below idle is bogging; clamping it back deletes that behaviour.
    if (!this.clutchEngaged) {
      if (this.engineOmega < idleOmega) {
        this.engineOmega += (idleOmega - this.engineOmega) * Math.min(1, dt * 16);
      }
    } else if (this.engineOmega < idleOmega * 0.4) {
      this.engineOmega = idleOmega * 0.4;
    }

    const maxOmega = (this.cfg.curve.redline * 2 * Math.PI) / 60;
    if (this.engineOmega > maxOmega) {
      this.engineOmega = maxOmega;
      this.heat = Math.min(1, this.heat + dt * 0.3);
    }
  }

  private integrate(dt: number): void {
    const driveForce = this.wheels.reduce((sum, w) => sum + w.fx, 0);
    const dragForce = 0.5 * AIR_DENSITY * this.cfg.dragArea * this.speed * this.speed;
    const rollForce = this.cfg.rollingResistance * this.cfg.mass * GRAVITY;

    let net = driveForce - dragForce - Math.sign(this.speed) * rollForce;

    if (Math.abs(this.speed) > 0.5 && this.gear > 0 && this.clutchEngaged) {
      const ratio = Math.abs(this.totalRatio);
      const engineBrake = (this.rpm * 0.0035 * this.cfg.engineInertia * ratio) / this.cfg.mass;
      net -= Math.sign(this.speed) * Math.min(Math.abs(this.speed) * 0.4, engineBrake);
    }

    const accel = net / this.cfg.mass;
    this.speed += accel * dt;
    this.lastAccel = accel;
    this.lastLateralAccel = 0;

    if (this.speed < 0 && net > 0) this.speed = 0;
    this.distance = Math.max(0, this.distance + this.speed * dt);
  }

  private updateHeat(dt: number, input: VehicleInputs): void {
    if (this.rpm > this.cfg.curve.redline * 0.97) this.heat = Math.min(1, this.heat + dt * 0.12);
    else this.heat = Math.max(0, this.heat - dt * 0.1);
    if (input.handbrake) this.heat = Math.min(1, this.heat + dt * 0.2);
  }

  private updateBodyAttitude(dt: number): void {
    const targetPitch = -this.lastAccel * 0.012;
    const targetRoll = -this.lastLateralAccel * 0.05;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 8);
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 8);
  }

  tickLaunch(dt: number): void {
    if (this.launch.timeLeft > 0) {
      this.launch.timeLeft = Math.max(0, this.launch.timeLeft - dt);
      if (this.launch.timeLeft === 0) {
        this.launch.traction = 1;
        this.launch.torque = 1;
        this.shiftState = 'running';
      }
    }
  }
}

export function makeVehicle(overrides: Partial<VehicleConfig> = {}): Vehicle {
  return new Vehicle({ ...DEFAULT_VEHICLE_CONFIG, ...overrides });
}
