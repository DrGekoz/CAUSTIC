/**
 * The garage.
 *
 * Cars are a purchase. Tuning is a branch tree with conflicts: a turbo kit
 * cannot coexist with a supercharger, so the shop has to say WHY a part is
 * unavailable rather than greying it out. A player who cannot see the rule will
 * conclude the game is broken.
 */

import { CARS, type CarSpec } from '../game/data/cars';
import {
  TUNING_TREE, canFit, resaleValue, garageValue, buyTuning, sellTuning, buyCar,
  type PlayerState, type BranchId, type TuningNode,
} from '../game/Economy';

const money = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');

export interface GarageHooks {
  /** The player picked a different car to drive. */
  onSelectCar: (carId: string) => void;
  /** Anything changed: re-render elsewhere and persist. */
  onChange: () => void;
}

export class GarageUI {
  readonly root: HTMLDivElement;
  private state: PlayerState;
  private activeCarId: string;
  private hooks: GarageHooks;
  private tab: 'cars' | 'tuning' = 'cars';

  constructor(parent: HTMLElement, state: PlayerState, activeCarId: string, hooks: GarageHooks) {
    this.state = state;
    this.activeCarId = activeCarId;
    this.hooks = hooks;
    this.root = document.createElement('div');
    this.root.className = 'garage';
    this.root.style.display = 'none';
    parent.appendChild(this.root);
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  set visible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
    if (v) this.render();
  }

  setState(state: PlayerState, activeCarId: string): void {
    this.state = state;
    this.activeCarId = activeCarId;
    if (this.visible) this.render();
  }

  private render(): void {
    this.root.innerHTML = `
      <header class="g-head">
        <h2>GARAGE</h2>
        <div class="g-cash">${money(this.state.cash)}</div>
        <div class="g-level">LV ${this.state.level} &middot; ${this.state.racesRun} races</div>
      </header>
      <nav class="g-tabs">
        <button data-tab="cars" class="${this.tab === 'cars' ? 'on' : ''}">Cars</button>
        <button data-tab="tuning" class="${this.tab === 'tuning' ? 'on' : ''}">Tuning</button>
      </nav>
      <div class="g-body"></div>
      <footer class="g-foot">
        <span>Garage value ${money(garageValue(this.state))}</span>
        <button data-act="close" class="primary">Back to the strip</button>
      </footer>
    `;

    const body = this.root.querySelector('.g-body') as HTMLDivElement;
    if (this.tab === 'cars') this.renderCars(body);
    else this.renderTuning(body);

    for (const b of Array.from(this.root.querySelectorAll('[data-tab]'))) {
      b.addEventListener('click', () => {
        this.tab = (b as HTMLElement).dataset.tab as 'cars' | 'tuning';
        this.render();
      });
    }
    this.root.querySelector('[data-act="close"]')?.addEventListener('click', () => {
      this.visible = false;
    });
  }

  private entry(): { carId: string; tuning: BranchId[]; condition: number; paid: number } | undefined {
    return this.state.garage.find((g) => g.carId === this.activeCarId);
  }

  private renderCars(body: HTMLDivElement): void {
    const owned = new Set(this.state.garage.map((g) => g.carId));
    const sorted = [...CARS].sort((a, b) => a.price - b.price || a.tier - b.tier);
    body.innerHTML = '<div class="g-grid">' + sorted.map((spec: CarSpec) => {
      const isOwned = owned.has(spec.id);
      const isActive = spec.id === this.activeCarId;
      const afford = this.state.cash >= spec.price;
      const cls = isActive ? 'car active' : isOwned ? 'car owned' : afford ? 'car' : 'car locked';
      const status = isActive
        ? 'IN THE QUEUE'
        : isOwned
          ? `OWNED · resale ${money(this.resaleHint(spec.id))}`
          : afford ? `BUY ${money(spec.price)}` : `${money(spec.price)} — too dear`;
      return `
        <button class="${cls}" data-car="${spec.id}" ${isActive ? 'disabled' : ''}>
          <span class="car-name">${spec.name}</span>
          <span class="car-class">T${spec.tier} ${spec.drive}</span>
          <span class="car-stat">${Math.round(spec.peakTorque)} Nm · ${spec.mass} kg</span>
          <span class="car-status">${status}</span>
        </button>`;
    }).join('') + '</div>';

    for (const b of Array.from(body.querySelectorAll('[data-car]'))) {
      b.addEventListener('click', () => this.buyOrSelect((b as HTMLElement).dataset.car!));
    }
  }

  private buyOrSelect(carId: string): void {
    const owned = this.state.garage.some((g) => g.carId === carId);
    if (!owned) {
      const res = buyCar(this.state, carId);
      if (!res.ok) {
        this.flash(res.reason ?? 'Cannot buy that');
        return;
      }
      this.flash(`${CAR_BY_NAME(carId)} is yours`);
    }
    this.activeCarId = carId;
    this.hooks.onSelectCar(carId);
    this.hooks.onChange();
    this.render();
  }

  private renderTuning(body: HTMLDivElement): void {
    const installed = new Set<BranchId>(this.entry()?.tuning ?? []);
    // Group by branch so conflicts read as engineering routes, not a flat list
    // of 34 unrelated parts.
    const byBranch = new Map<string, TuningNode[]>();
    for (const node of TUNING_TREE) {
      const list = byBranch.get(node.branch) ?? [];
      list.push(node);
      byBranch.set(node.branch, list);
    }

    let html = '';
    for (const [branch, nodes] of byBranch) {
      html += `<section class="g-branch"><h3>${branch}</h3><div class="g-parts">`;
      for (const node of nodes) {
        const has = installed.has(node.id);
        const fit = has ? { ok: true as const } : canFit(node.id, installed);
        const afford = this.state.cash >= node.price;
        const usable = fit.ok && afford;
        const why = has
          ? 'FITTED — tap to sell'
          : !fit.ok ? (fit.reason ?? 'Conflicts with fitted parts')
          : afford ? money(node.price)
          : `${money(node.price)} — too dear`;
        const cls = has ? 'part fitted' : usable ? 'part' : 'part blocked';
        html += `
          <button class="${cls}" data-part="${node.id}" ${has || usable ? '' : 'disabled'}>
            <span class="part-name">${node.name}</span>
            <span class="part-eff">${describeEffects(node)}</span>
            <span class="part-why">${why}</span>
          </button>`;
      }
      html += '</div></section>';
    }
    body.innerHTML = html;

    for (const b of Array.from(body.querySelectorAll('[data-part]'))) {
      b.addEventListener('click', () => this.togglePart((b as HTMLElement).dataset.part! as BranchId));
    }
  }

  private togglePart(nodeId: BranchId): void {
    const installed = new Set<BranchId>(this.entry()?.tuning ?? []);
    const res = installed.has(nodeId)
      ? sellTuning(this.state, this.activeCarId, nodeId)
      : buyTuning(this.state, this.activeCarId, nodeId);
    if (!res.ok) this.flash(res.reason ?? 'Cannot fit that');
    this.hooks.onChange();
    this.render();
  }

  private flash(message: string): void {
    const el = document.createElement('div');
    el.className = 'g-flash';
    el.textContent = message;
    this.root.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  resaleHint(carId: string): number {
    const e = this.state.garage.find((g) => g.carId === carId);
    if (!e) return 0;
    const spec = CAR_BY_NAME_SPEC(carId);
    return spec ? resaleValue(e, spec) : 0;
  }
}

function CAR_BY_NAME(id: string): string {
  return CAR_BY_NAME_SPEC(id)?.name ?? id;
}

let specIndex: Map<string, CarSpec> | null = null;
function CAR_BY_NAME_SPEC(id: string): CarSpec | undefined {
  if (!specIndex) specIndex = new Map(CARS.map((c) => [c.id, c]));
  return specIndex.get(id);
}

function describeEffects(node: TuningNode): string {
  const e = node.effects;
  const out: string[] = [];
  const pct = (v: number | undefined, base = 1): string | null =>
    v === undefined || v === base ? null : `${v > base ? '+' : ''}${Math.round((v - base) * 100)}%`;

  const torque = pct(e.torqueMult);
  if (torque) out.push(`${torque} torque`);
  const grip = pct(e.gripMult);
  if (grip) out.push(`${grip} grip`);
  if (e.massMult !== undefined && e.massMult !== 1) {
    const m = Math.round((1 - e.massMult) * 100);
    out.push(`${m > 0 ? '-' : '+'}${Math.abs(m)}% mass`);
  }
  // redlineBonus is ABSOLUTE rpm, not a fraction: a turbo kit adds 400 rpm.
  if (e.redlineBonus !== undefined && e.redlineBonus !== 0) {
    out.push(`${e.redlineBonus > 0 ? '+' : ''}${Math.round(e.redlineBonus)} rpm`);
  }
  const shift = pct(e.shiftTimeMult);
  if (shift) out.push(`${shift} shift time`);
  if (e.launchBandMult !== undefined && e.launchBandMult !== 1) {
    const b = Math.round((e.launchBandMult - 1) * 100);
    out.push(`${b > 0 ? '+' : ''}${b}% launch window`);
  }
  if (e.stallRpmBonus !== undefined && e.stallRpmBonus !== 0) {
    out.push(`stalls ${e.stallRpmBonus > 0 ? 'earlier' : 'later'}`);
  }
  return out.length ? out.join(' \u00b7 ') : 'no measurable effect';
}
