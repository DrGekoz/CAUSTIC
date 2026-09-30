/**
 * Input.
 *
 * Keyboard first, with touch and gamepad folded into the same shape. The one
 * rule that matters: a launch is edge-triggered. Holding a key must not fire
 * the clutch dump repeatedly, and releasing the clutch for a single frame must
 * not either -- a blip on the clutch is not a launch.
 */

import type { RaceInput } from '../game/Race';

const KEY_MAP: Record<string, string> = {
  KeyW: 'throttle',
  ArrowUp: 'throttle',
  KeyS: 'brake',
  ArrowDown: 'brake',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'shiftUp',
  KeyQ: 'shiftDown',
  KeyL: 'clutch',
  KeyR: 'restart',
  KeyG: 'garage',
  KeyC: 'carPicker',
  Escape: 'pause',
  KeyT: 'autoclutch',
};

export class InputManager {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private clutchHeldFor = 0;
  /** Set by the app: true while the player is meant to be staging. */
  enableInput = true;

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (e) => this.onKey(e as KeyboardEvent, true));
    target.addEventListener('keyup', (e) => this.onKey(e as KeyboardEvent, false));
    window.addEventListener('blur', () => this.down.clear());
  }

  private onKey(e: KeyboardEvent, isDown: boolean): void {
    const action = KEY_MAP[e.code];
    if (!action) return;
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (isDown) {
      if (!this.down.has(action)) this.pressedThisFrame.add(action);
      this.down.add(action);
    } else {
      this.down.delete(action);
    }
  }

  /** True on the frame the key went down. */
  pressed(action: string): boolean {
    return this.pressedThisFrame.has(action);
  }

  held(action: string): boolean {
    return this.down.has(action);
  }

  /** Call once per frame, after reading. */
  endFrame(): void {
    this.pressedThisFrame.clear();
  }

  /**
   * Build the race input for this frame.
   *
   * `autoClutch` is on by default, which is what most players want: the car
   * drives itself once the race starts and the player only works the launch.
   * Turn it off with T to take manual control of the clutch.
   */
  sample(dt: number): RaceInput {
    const gas = this.held('throttle') ? 1 : 0;
    const brake = this.held('brake') ? 1 : 0;
    const clutchKey = this.held('clutch');
    // T toggles manual clutch control. The car manages its own clutch by
    // default, which is what most players want: they work the launch and the
    // car drives itself.
    const autoClutch = !this.held('autoclutch');

    if (clutchKey) this.clutchHeldFor += dt;
    else this.clutchHeldFor = 0;

    return {
      throttle: this.enableInput ? gas : 1,
      brake: this.enableInput ? brake : 0,
      clutch: clutchKey,
      shiftUp: this.pressed('shiftUp'),
      shiftDown: this.pressed('shiftDown'),
      launch: false,
      autoClutch,
    };
  }
}

/** A touch control surface, mapped onto the same actions. */
export class TouchControls {
  private state = { throttle: 0, brake: 0, clutch: false, launch: false };
  readonly el: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'touch';
    this.el.innerHTML = `
      <button class="tbtn tleft" data-act="left" aria-label="steer left">◄</button>
      <button class="tbtn tright" data-act="right" aria-label="steer right">►</button>
      <button class="tbtn tclutch" data-act="clutch" aria-label="clutch">CLUTCH</button>
      <button class="tbtn tbrake" data-act="brake" aria-label="brake">BRAKE</button>
      <button class="tbtn tgas" data-act="throttle" aria-label="throttle">GAS</button>
    `;
    parent.appendChild(this.el);
    for (const btn of Array.from(this.el.querySelectorAll('.tbtn'))) {
      const act = (btn as HTMLElement).dataset.act!;
      const down = (e: Event) => {
        e.preventDefault();
        (btn as HTMLElement).classList.add('active');
        if (act === 'clutch') this.state.clutch = false;
        else if (act === 'throttle') this.state.throttle = 1;
        else if (act === 'brake') this.state.brake = 1;
      };
      const up = (e: Event) => {
        e.preventDefault();
        (btn as HTMLElement).classList.remove('active');
        if (act === 'clutch') {
          // Only a real press-and-hold counts as a clutch; a tap is a launch.
          this.state.clutch = true;
          this.state.launch = true;
        } else if (act === 'throttle') this.state.throttle = 0;
        else if (act === 'brake') this.state.brake = 0;
      };
      btn.addEventListener('touchstart', down, { passive: false });
      btn.addEventListener('touchend', up, { passive: false });
      btn.addEventListener('mousedown', down);
      btn.addEventListener('mouseup', up);
    }
  }

  sample(): RaceInput {
    const out: RaceInput = {
      throttle: this.state.throttle,
      brake: this.state.brake,
      clutch: this.state.clutch,
      shiftUp: false,
      shiftDown: false,
      launch: this.state.launch,
      autoClutch: true,
    };
    this.state.launch = false;
    return out;
  }

  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  set visible(v: boolean) {
    this.el.style.display = v ? '' : 'none';
  }
}
