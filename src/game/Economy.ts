/**
 * The economy.
 *
 * Cash comes from winning races, buying cars, and selling them back. Tuning is
 * a mutually exclusive BRANCH TREE, not a flat numeric ladder: a turbo kit
 * conflicts with a supercharger and with the NA cam, so the player is buying a
 * coherent engineering philosophy rather than watching an opaque stat tick up.
 *
 * Everything here is pure and synchronous, which is why it is the most heavily
 * tested part of the game and the cheapest to get right.
 */

import { CARS, CAR_BY_ID, type CarSpec } from './data/cars';

// ---------------------------------------------------------------------------
// Tuning tree
// ---------------------------------------------------------------------------

export type BranchId =
  | 'turbo_kit' | 'supercharger' | 'na_cams' | 'port_injection' | 'big_intercooler'
  | 'exhaust' | 'catback' | 'straight_pipe' | 'camshaft' | 'valve_spring'
  | 'flywheel' | 'clutch_upgrade' | 'lsd' | 'wider_rears' | 'slicks' | 'drag_rims'
  | 'shock_upgrade' | 'springs' | 'antiroll' | 'subframe_ties' | 'chassis_cage'
  | 'nitrous' | 'roll_cage_weld' | 'weight_strip' | 'fuel_cell' | 'line_lock'
  | 'transbrake' | 'three_speed' | 'tall_gearbox' | 'diff_ratio' | 'gearing_stage1'
  | 'gearing_stage2' | 'gearing_street' | 'dyno_tune' | 'data_acquisition';

export interface TuningNode {
  id: BranchId;
  name: string;
  /** What it does, in the shop UI. */
  blurb: string;
  branch: 'engine' | 'exhaust' | 'drivetrain' | 'chassis' | 'gearing' | 'data';
  price: number;
  /** Mutually exclusive with these. */
  conflictsWith: BranchId[];
  /** ALL of these must be fitted first. */
  requires: BranchId[];
  /**
   * At least ONE of these must be fitted first. This exists because "requires"
   * is a conjunction, and the intercooler needs a forced-induction engine --
   * which means a turbo OR a supercharger, and those two are mutually
   * exclusive, so demanding both made the part unfittable in every legal build.
   */
  requiresAny?: BranchId[];
  /** Multipliers applied to the vehicle config. */
  effects: Partial<TuningEffects>;
  tier: number;
}

export interface TuningEffects {
  torqueMult: number;
  gripMult: number;
  massMult: number;
  redlineBonus: number;
  /** Directly reduces shift time. */
  shiftTimeMult: number;
  /** Stiffer launch: widens the perfect band. */
  launchBandMult: number;
  /** Lower the stall threshold, so a worse launch still moves. */
  stallRpmBonus: number;
}

export const NO_EFFECTS: TuningEffects = {
  torqueMult: 1,
  gripMult: 1,
  massMult: 1,
  redlineBonus: 0,
  shiftTimeMult: 1,
  launchBandMult: 1,
  stallRpmBonus: 0,
};

/**
 * The branch tree. Every engine-path node conflicts with the other engine-path
 * node; the exhaust is a three-way exclusive; gearing is an exclusive set.
 */
export const TUNING_TREE: TuningNode[] = [
  // --- engine ---
  { id: 'turbo_kit', name: 'Turbo Kit', blurb: 'Big single top-mount. Lumpy, laggy, enormous.', branch: 'engine',
    price: 24000, conflictsWith: ['na_cams', 'supercharger'], requires: [], tier: 1,
    effects: { torqueMult: 1.55, redlineBonus: 400 } },
  { id: 'supercharger', name: 'Supercharger', blurb: 'Positive displacement. Linear, instant, thirsty.', branch: 'engine',
    price: 21000, conflictsWith: ['turbo_kit', 'na_cams'], requires: [], tier: 1,
    effects: { torqueMult: 1.38, redlineBonus: 900 } },
  { id: 'na_cams', name: 'NA Cams + Intake', blurb: 'No forced induction. Highest revs, least low end.', branch: 'engine',
    price: 14000, conflictsWith: ['turbo_kit', 'supercharger'], requires: [], tier: 1,
    effects: { torqueMult: 1.12, redlineBonus: 2200 } },
  { id: 'camshaft', name: 'Camshaft', blurb: 'More lift, more duration, a lumpy idle.', branch: 'engine',
    price: 9000, conflictsWith: ['valve_spring'], requires: ['na_cams'], tier: 2,
    effects: { torqueMult: 1.16, redlineBonus: 800 } },
  { id: 'valve_spring', name: 'Valve Springs', blurb: 'Lets the engine breathe past the stock limiter.', branch: 'engine',
    price: 4200, conflictsWith: ['camshaft'], requires: [], tier: 1,
    effects: { redlineBonus: 1200 } },
  { id: 'port_injection', name: 'Port Injection', blurb: 'Individual runners straight into the head.', branch: 'engine',
    price: 6800, conflictsWith: ['big_intercooler'], requires: [], tier: 2,
    effects: { torqueMult: 1.09 } },
  { id: 'big_intercooler', name: 'Intercooler + Piping', blurb: 'Keeps a boosted engine cool and dense.', branch: 'engine',
    price: 5200, conflictsWith: ['port_injection'], requires: [],
    requiresAny: ['turbo_kit', 'supercharger'], tier: 2,
    effects: { torqueMult: 1.1 } },

  // --- exhaust: a three-way exclusive, and the cheapest power on the board ---
  { id: 'catback', name: 'Cat-Back Exhaust', blurb: 'Quiet, cheap, almost legal.', branch: 'exhaust',
    price: 1800, conflictsWith: ['straight_pipe', 'exhaust'], requires: [], tier: 1,
    effects: { torqueMult: 1.04 } },
  { id: 'exhaust', name: 'Full System', blurb: 'Headers, mid-pipe, muffler. The balanced choice.', branch: 'exhaust',
    price: 3600, conflictsWith: ['catback', 'straight_pipe'], requires: [], tier: 1,
    effects: { torqueMult: 1.07 } },
  { id: 'straight_pipe', name: 'Straight Pipe', blurb: 'No muffler at all. Loud enough to be illegal.', branch: 'exhaust',
    price: 900, conflictsWith: ['catback', 'exhaust'], requires: [], tier: 1,
    effects: { torqueMult: 1.05, massMult: 0.997 } },

  // --- drivetrain ---
  { id: 'clutch_upgrade', name: 'Twin-Plate Clutch', blurb: 'Holds launch rpm instead of slipping.', branch: 'drivetrain',
    price: 5600, conflictsWith: ['flywheel'], requires: [], tier: 1,
    effects: { launchBandMult: 1.35, shiftTimeMult: 0.8 } },
  { id: 'flywheel', name: 'Lightweight Flywheel', blurb: 'Spins up fast. Makes the car harder to hold on the line.', branch: 'drivetrain',
    price: 3200, conflictsWith: ['clutch_upgrade'], requires: [], tier: 1,
    effects: { torqueMult: 1.03, massMult: 0.99, launchBandMult: 0.85 } },
  { id: 'transbrake', name: 'Transbrake', blurb: 'Locks first gear. Turns a launch into a switch.', branch: 'drivetrain',
    price: 8900, conflictsWith: ['line_lock'], requires: [], tier: 2,
    effects: { launchBandMult: 1.5, shiftTimeMult: 0.9 } },
  { id: 'line_lock', name: 'Line Lock', blurb: 'Holds the car on the brakes until you say go.', branch: 'drivetrain',
    price: 1400, conflictsWith: ['transbrake'], requires: [], tier: 1,
    effects: { launchBandMult: 1.18 } },
  { id: 'lsd', name: 'Limited-Slip Diff', blurb: 'Both rear wheels hooked up instead of one.', branch: 'drivetrain',
    price: 2200, conflictsWith: [], requires: [], tier: 1,
    effects: { gripMult: 1.06 } },

  // --- chassis ---
  { id: 'slicks', name: 'Slicks', blurb: 'Full-width drag radials. Enormous grip, useless on the street.', branch: 'chassis',
    price: 1900, conflictsWith: ['wider_rears', 'drag_rims'], requires: [], tier: 1,
    effects: { gripMult: 1.3, shiftTimeMult: 0.97 } },
  { id: 'wider_rears', name: 'Wider Rear Tyres', blurb: 'More rubber than sidewall.', branch: 'chassis',
    price: 1200, conflictsWith: ['slicks'], requires: [], tier: 1,
    effects: { gripMult: 1.13 } },
  { id: 'drag_rims', name: 'Drag Wheels', blurb: 'Slicks on a beadlock. Light, stiff, brake-friendly.', branch: 'chassis',
    price: 4100, conflictsWith: ['slicks'], requires: [], tier: 2,
    effects: { gripMult: 1.24, massMult: 0.985 } },
  { id: 'shock_upgrade', name: 'Adjustable Shocks', blurb: 'Sets the car up for a hook, not a corner.', branch: 'chassis',
    price: 2600, conflictsWith: ['springs'], requires: [], tier: 1,
    effects: { gripMult: 1.08, launchBandMult: 1.1 } },
  { id: 'springs', name: 'Drag Springs', blurb: 'Stiffer, shorter, less weight transfer.', branch: 'chassis',
    price: 1300, conflictsWith: ['shock_upgrade'], requires: [], tier: 1,
    effects: { gripMult: 1.05, massMult: 0.996 } },
  { id: 'antiroll', name: 'Anti-Roll Bars', blurb: 'Keeps the outside wheel loaded.', branch: 'chassis',
    price: 900, conflictsWith: [], requires: [], tier: 1,
    effects: { gripMult: 1.04 } },
  { id: 'subframe_ties', name: 'Subframe Ties', blurb: 'Stops the shell flexing under load.', branch: 'chassis',
    price: 750, conflictsWith: [], requires: [], tier: 1,
    effects: { gripMult: 1.03, massMult: 0.998 } },
  { id: 'chassis_cage', name: 'Welded Cage', blurb: 'Stiff shell. Worth ~80kg of everything else.', branch: 'chassis',
    price: 6800, conflictsWith: ['weight_strip'], requires: [], tier: 2,
    effects: { massMult: 0.965, gripMult: 1.04 } },
  { id: 'weight_strip', name: 'Interior Strip', blurb: 'Take out everything you do not need.', branch: 'chassis',
    price: 1600, conflictsWith: ['chassis_cage'], requires: [], tier: 1,
    effects: { massMult: 0.955 } },

  // --- gearing: an exclusive set, because ratios are mutually exclusive ---
  { id: 'three_speed', name: 'Three-Speed Transmission', blurb: 'Short gears, huge first. The classic bracket racer.', branch: 'gearing',
    price: 7800, conflictsWith: ['tall_gearbox', 'diff_ratio', 'gearing_stage1', 'gearing_stage2', 'gearing_street'],
    requires: [], tier: 2, effects: { launchBandMult: 1.15, shiftTimeMult: 0.7 } },
  { id: 'tall_gearbox', name: 'Tall Gearbox', blurb: 'Fewer revs between shifts, more top end.', branch: 'gearing',
    price: 6200, conflictsWith: ['three_speed', 'diff_ratio', 'gearing_stage1', 'gearing_stage2', 'gearing_street'],
    requires: [], tier: 2, effects: { shiftTimeMult: 0.85, massMult: 0.99 } },
  { id: 'diff_ratio', name: 'Ring and Pinion Swap', blurb: 'Shorter final drive. More pull everywhere.', branch: 'gearing',
    price: 2400, conflictsWith: ['three_speed', 'tall_gearbox', 'gearing_stage1', 'gearing_stage2', 'gearing_street'],
    requires: [], tier: 1, effects: { launchBandMult: 1.2, shiftTimeMult: 1.1 } },
  { id: 'gearing_stage1', name: 'Stage 1 Gearing', blurb: 'Balanced ratios for a street-then-strip car.', branch: 'gearing',
    price: 1800, conflictsWith: ['three_speed', 'tall_gearbox', 'diff_ratio', 'gearing_stage2', 'gearing_street'],
    requires: [], tier: 1, effects: { shiftTimeMult: 0.95 } },
  { id: 'gearing_stage2', name: 'Stage 2 Gearing', blurb: 'Aggressive. Everything happens now.', branch: 'gearing',
    price: 3900, conflictsWith: ['three_speed', 'tall_gearbox', 'diff_ratio', 'gearing_stage1', 'gearing_street'],
    requires: [], tier: 2, effects: { shiftTimeMult: 0.9, launchBandMult: 1.12 } },
  { id: 'gearing_street', name: 'Stock Ratios', blurb: 'Slow off the line, good everywhere else.', branch: 'gearing',
    price: 0, conflictsWith: ['three_speed', 'tall_gearbox', 'diff_ratio', 'gearing_stage1', 'gearing_stage2'],
    requires: [], tier: 1, effects: {} },

  // --- data ---
  { id: 'dyno_tune', name: 'Dyno Tune', blurb: 'Someone has actually measured the map.', branch: 'data',
    price: 3200, conflictsWith: [], requires: [], tier: 2, effects: { torqueMult: 1.07 } },
  { id: 'data_acquisition', name: 'Data Acquisition', blurb: 'Every run is logged. Shows you where the time went.', branch: 'data',
    price: 4500, conflictsWith: [], requires: [], tier: 2, effects: { launchBandMult: 1.12 } },
  { id: 'nitrous', name: 'Nitrous Stage 1', blurb: 'Wet nitrous. Huge, and it eats the engine.', branch: 'data',
    price: 14000, conflictsWith: [], requires: ['dyno_tune'], tier: 3, effects: { torqueMult: 1.22 } },
  { id: 'roll_cage_weld', name: 'Cage Welds', blurb: 'Do not ask. Ask why it is faster.', branch: 'data',
    price: 1100, conflictsWith: [], requires: ['chassis_cage'], tier: 3, effects: { massMult: 0.992 } },
  { id: 'fuel_cell', name: 'Fuel Cell', blurb: 'Lighter than the tank it replaces.', branch: 'data',
    price: 3800, conflictsWith: [], requires: [], tier: 2, effects: { massMult: 0.985 } },
];

export const TUNING_BY_ID = new Map<BranchId, TuningNode>(TUNING_TREE.map((n) => [n.id, n]));

/** Can this node be fitted right now, given what is already installed? */
export function canFit(
  id: BranchId,
  installed: ReadonlySet<BranchId>,
): { ok: boolean; reason?: string } {
  const node = TUNING_BY_ID.get(id);
  if (!node) return { ok: false, reason: 'Unknown part' };
  if (installed.has(id)) return { ok: false, reason: 'Already fitted' };
  for (const r of node.requires) {
    if (!installed.has(r)) {
      return { ok: false, reason: `Requires ${TUNING_BY_ID.get(r)?.name ?? r}` };
    }
  }
  if (node.requiresAny && node.requiresAny.length > 0) {
    // Satisfied by ANY one of the alternatives. Treating these as a conjunction
    // made the intercooler require a turbo AND a supercharger, which are
    // mutually exclusive, so it was unfittable in every legal build.
    if (!node.requiresAny.some((r) => installed.has(r))) {
      const names = node.requiresAny.map((r) => TUNING_BY_ID.get(r)?.name ?? r).join(' or ');
      return { ok: false, reason: `Requires ${names}` };
    }
  }
  for (const c of installed) {
    const other = TUNING_BY_ID.get(c);
    if (other && other.conflictsWith.includes(id)) {
      return { ok: false, reason: `Conflicts with ${other.name}` };
    }
  }
  return { ok: true };
}

/** Fold every installed node's effects into one multiplier set. */
export function combineEffects(installed: ReadonlySet<BranchId>): TuningEffects {
  const out: TuningEffects = { ...NO_EFFECTS };
  for (const id of installed) {
    const n = TUNING_BY_ID.get(id);
    if (!n) continue;
    const e = n.effects;
    if (e.torqueMult) out.torqueMult *= e.torqueMult;
    if (e.gripMult) out.gripMult *= e.gripMult;
    if (e.massMult) out.massMult *= e.massMult;
    if (e.redlineBonus) out.redlineBonus += e.redlineBonus;
    if (e.shiftTimeMult) out.shiftTimeMult *= e.shiftTimeMult;
    if (e.launchBandMult) out.launchBandMult *= e.launchBandMult;
    if (e.stallRpmBonus) out.stallRpmBonus += e.stallRpmBonus;
  }
  // A blown engine cannot exceed a sane ceiling regardless of stacking.
  out.torqueMult = Math.min(2.6, out.torqueMult);
  out.gripMult = Math.min(2.0, out.gripMult);
  out.massMult = Math.max(0.85, out.massMult);
  return out;
}

// ---------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------

export interface Rival {
  id: string;
  name: string;
  /** Which car they drive. */
  carId: string;
  /** Their hand-built ET, seconds, for a 1320ft pass. */
  baselineEt: number;
  band: 1 | 2 | 3 | 4;
  /** Cash on the table. */
  stake: number;
  blurb: string;
}

/**
 * An AUTHORED ladder, not a difficulty curve keyed to the player's level. The
 * reference game scaled rivals off the player level, which punishes investment
 * and makes progression feel like a treadmill.
 */
export const RIVALS: Rival[] = [
  { id: 'r0', name: 'Tuesday Night Club', carId: 'rusty8', baselineEt: 14.9, band: 1, stake: 500,
    blurb: 'Nobody here is trying.' },
  { id: 'r1', name: 'Dave From The Office', carId: 'hatch', baselineEt: 14.1, band: 1, stake: 900,
    blurb: 'Owns a turbo wagon. Regrets it.' },
  { id: 'r2', name: 'The Landlord', carId: 'ranchero', baselineEt: 13.4, band: 1, stake: 1600,
    blurb: 'Will talk about your launch all night.' },
  { id: 'r3', name: 'Sandbox Randy', carId: 'ninemiler', baselineEt: 12.7, band: 2, stake: 2800,
    blurb: 'Runs a nitrous kit on a street car.' },
  { id: 'r4', name: 'Quiet Girl In The Blue Skyline', carId: 'skyline', baselineEt: 12.0, band: 2, stake: 4200,
    blurb: 'Has never lost and will not say so.' },
  { id: 'r5', name: 'Phil From Accounting', carId: 'silvia', baselineEt: 11.4, band: 2, stake: 6400,
    blurb: 'Spreadsheets, but fast ones.' },
  { id: 'r6', name: 'The Big Single Guy', carId: 'rsturbo', baselineEt: 10.7, band: 3, stake: 9500,
    blurb: 'Points at his engine. Often.' },
  { id: 'r7', name: 'G Wagon AMG', carId: 'gwagon', baselineEt: 10.2, band: 3, stake: 14000,
    blurb: 'Quarter-miles in a 700kg SUV. Nobody knows why.' },
  { id: 'r8', name: 'Vettore', carId: 'vettore', baselineEt: 9.6, band: 3, stake: 21000,
    blurb: 'Italian. Says one word per run.' },
  { id: 'r9', name: 'The Ghibli Owner', carId: 'ghib', baselineEt: 9.0, band: 4, stake: 32000,
    blurb: 'Brought it to a drag strip. Of course they did.' },
  { id: 'r10', name: 'Apex One', carId: 'apexone', baselineEt: 8.3, band: 4, stake: 48000,
    blurb: 'Built in a shed. Very fast in a shed.' },
  { id: 'r11', name: 'Nightlaw', carId: 'nightlaw', baselineEt: 7.6, band: 4, stake: 70000,
    blurb: 'The one everyone is waiting for.' },
];

export interface RaceOutcome {
  won: boolean;
  stake: number;
  /** Cash won (stake + margin) or lost (0). */
  payout: number;
  /** Your ET. */
  yourEt: number;
  /** Their ET. */
  theirEt: number;
  margin: number;
  /** Launch grade that produced this result. */
  launchMultiplier: number;
}

/**
 * Resolve a race. The rival's ET varies slightly band to band so a repeated
 * race is not a coin flip on a fixed number.
 */
export function resolveRace(
  yourEt: number,
  rival: Rival,
  launchMultiplier: number,
  seed: number,
): RaceOutcome {
  // ±3% rival variation, deterministic from the seed.
  const wobble = 1 + (((seed * 2654435761) % 1000) / 1000 - 0.5) * 0.06;
  const theirEt = rival.baselineEt * wobble;
  const margin = theirEt - yourEt;
  const won = margin > 0;
  if (!won) {
    return { won, stake: rival.stake, payout: 0, yourEt, theirEt, margin, launchMultiplier };
  }
  // Winning pays the stake plus a bonus that SHRINKS as the margin grows.
  // The reward for a win is the stake; the margin only modulates a small
  // performance bonus, and being massively faster should not pay the most.
  const tightness = Math.max(0, 1 - Math.min(1, margin / 1.2));
  const payout = Math.round(rival.stake * (1 + 0.6 * tightness) * launchMultiplier);
  return { won, stake: rival.stake, payout, yourEt, theirEt, margin, launchMultiplier };
}

// ---------------------------------------------------------------------------
// Player state
// ---------------------------------------------------------------------------

export interface GarageCar {
  carId: string;
  /** Installed tuning branch ids. */
  tuning: BranchId[];
  /** 0..1 condition. Falls off with wheelspin and hard launches. */
  condition: number;
  /** Purchase price, for resale maths. */
  paid: number;
}

export interface PlayerState {
  cash: number;
  xp: number;
  level: number;
  /** Owned cars, keyed by car id. */
  garage: GarageCar[];
  /** Rival ids already beaten. */
  beaten: Set<string>;
  /** Best ET ever recorded. */
  bestEt: number;
  racesRun: number;
  perfectLaunches: number;
}

export function newPlayer(): PlayerState {
  return {
    cash: 0,
    xp: 0,
    level: 1,
    garage: [{ carId: 'rusty8', tuning: [], condition: 1, paid: 0 }],
    beaten: new Set<string>(),
    bestEt: Number.POSITIVE_INFINITY,
    racesRun: 0,
    perfectLaunches: 0,
  };
}

/** XP required to reach the next level. Quadratic: 100 * level^2. */
export function xpForLevel(level: number): number {
  return 100 * level * level;
}

export function levelFromXp(xp: number): { level: number; into: number; needed: number } {
  let level = 1;
  let remaining = xp;
  while (remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level++;
  }
  return { level, into: remaining, needed: xpForLevel(level) };
}

/**
 * Resale value with depreciation. Parts return only half their modified value,
 * which is what makes a wrong branch choice actually hurt: you are not getting
 * your money back.
 */
export function resaleValue(car: GarageCar, spec: CarSpec): number {
  const base = spec.price * car.condition * 0.8;
  let modValue = 0;
  for (const id of car.tuning) {
    const node = TUNING_BY_ID.get(id);
    if (node) modValue += node.price;
  }
  // Installed parts are worth half of what they cost, and condition loss
  // applies to them too.
  return Math.round(base + modValue * 0.5 * (0.5 + car.condition * 0.5));
}

export function canAfford(state: PlayerState, amount: number): boolean {
  return state.cash >= amount;
}

export function buyTuning(
  state: PlayerState,
  carId: string,
  nodeId: BranchId,
): { ok: boolean; reason?: string; cashAfter?: number } {
  const entry = state.garage.find((g) => g.carId === carId);
  if (!entry) return { ok: false, reason: 'You do not own that car' };
  const node = TUNING_BY_ID.get(nodeId);
  if (!node) return { ok: false, reason: 'Unknown part' };
  const installed = new Set<BranchId>(entry.tuning);
  const fit = canFit(nodeId, installed);
  if (!fit.ok) return { ok: false, reason: fit.reason };
  if (state.cash < node.price) return { ok: false, reason: 'Not enough cash' };
  state.cash -= node.price;
  entry.tuning.push(nodeId);
  return { ok: true, cashAfter: state.cash };
}

export function sellTuning(state: PlayerState, carId: string, nodeId: BranchId): { ok: boolean; reason?: string; cashAfter?: number } {
  const entry = state.garage.find((g) => g.carId === carId);
  if (!entry) return { ok: false, reason: 'You do not own that car' };
  const node = TUNING_BY_ID.get(nodeId);
  if (!node) return { ok: false, reason: 'Unknown part' };
  const i = entry.tuning.indexOf(nodeId);
  if (i < 0) return { ok: false, reason: 'Not fitted' };
  // Half value, no more. Parts that are part of a build are not recoverable.
  const refund = Math.round(node.price * 0.5);
  entry.tuning.splice(i, 1);
  state.cash += refund;
  return { ok: true, cashAfter: state.cash };
}

export function buyCar(state: PlayerState, carId: string): { ok: boolean; reason?: string } {
  const spec = CAR_BY_ID[carId];
  if (!spec) return { ok: false, reason: 'Unknown car' };
  if (state.garage.some((g) => g.carId === carId)) return { ok: false, reason: 'Already owned' };
  if (state.cash < spec.price) return { ok: false, reason: 'Not enough cash' };
  state.cash -= spec.price;
  state.garage.push({ carId, tuning: [], condition: 1, paid: spec.price });
  return { ok: true };
}

export function sellCar(state: PlayerState, carId: string): { ok: boolean; reason?: string; cashAfter?: number } {
  const i = state.garage.findIndex((g) => g.carId === carId);
  if (i < 0) return { ok: false, reason: 'You do not own that car' };
  if (state.garage.length <= 1) return { ok: false, reason: 'You need at least one car' };
  const entry = state.garage[i];
  const spec = CAR_BY_ID[entry.carId];
  const value = resaleValue(entry, spec);
  state.cash += value;
  state.garage.splice(i, 1);
  return { ok: true, cashAfter: state.cash };
}

/** Apply a race result to the player state. Mutates in place. */
export function applyRace(
  state: PlayerState,
  outcome: RaceOutcome,
  rival: Rival,
  entry: GarageCar,
  perfect: boolean,
): void {
  state.racesRun++;
  if (perfect) state.perfectLaunches++;
  state.cash += outcome.payout;
  state.xp += Math.round((outcome.won ? 220 : 60) * rival.band);
  if (outcome.yourEt < state.bestEt) state.bestEt = outcome.yourEt;
  if (outcome.won) state.beaten.add(rival.id);
  // Wheelspin and a blown launch both hurt the car.
  const wear = outcome.won ? (perfect ? 0.0 : 0.012) : 0.02;
  entry.condition = Math.max(0.35, Math.min(1, entry.condition - wear));
}

/** The next rival the player can take on, given progress. */
export function nextRival(state: PlayerState): Rival | null {
  for (const r of RIVALS) {
    if (!state.beaten.has(r.id)) return r;
  }
  return null;
}

/** Rival is unlocked once the player can plausibly beat the one before. */
export function rivalUnlocked(state: PlayerState, rival: Rival): boolean {
  if (rival.band === 1) return true;
  const idx = RIVALS.indexOf(rival);
  const prev = RIVALS[idx - 1];
  return prev ? state.beaten.has(prev.id) : true;
}

/** Total cash tied up in the garage, for the shop header. */
export function garageValue(state: PlayerState): number {
  return state.garage.reduce((sum, g) => sum + resaleValue(g, CAR_BY_ID[g.carId]), 0);
}

export { CARS, CAR_BY_ID };
export type { CarSpec };
