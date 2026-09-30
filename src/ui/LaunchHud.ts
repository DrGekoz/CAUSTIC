/**
 * The launch window HUD.
 *
 * The mechanic is invisible without this: the player has to see the band, see
 * the needle inside it, and see the result. Drawn as a canvas overlay rather
 * than DOM because it updates every frame and needs a gradient.
 */

import type { RaceSnapshot } from '../game/Race';


const GRADE_COLOUR: Record<string, string> = {
  BOG: '#5b6472',
  POOR: '#8a6d3b',
  GOOD: '#2ecc71',
  GREAT: '#f1c40f',
  PERFECT: '#ff2d95',
  BLOWN: '#e74c3c',
};

export class LaunchHud {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private flashUntil = 0;
  private lastGrade = '';

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'launchhud';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    }
  }

  /** The rev window as a horizontal bar, with the needle at the current rpm. */
  draw(snap: RaceSnapshot, now: number, rivalName = 'RIVAL'): void {
    this.resize();
    const g = this.ctx;
    if (!g || this.canvas.width === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    g.clearRect(0, 0, W, H);

    if (snap.phase === 'FINISHED' || snap.phase === 'IDLE') {
      this.drawResult(g, W, H, snap, now, rivalName);
      return;
    }

    const b = snap.bands;
    const lo = b.bogLow;
    const hi = b.spinHigh;
    const pos = (rpm: number) => ((rpm - lo) / Math.max(1, hi - lo)) * (W - 8) + 4;

    const barY = H * 0.52;
    const barH = 22;

    // Zones, painted back to front.
    this.zone(g, 4, barY, pos(b.bogLow) - 4, '#23262c', 'BOG');
    this.zone(g, pos(b.bogLow), barY, pos(b.goodLow) - pos(b.bogLow), '#6b5a2e', 'POOR');
    this.zone(g, pos(b.goodLow), barY, pos(b.perfectLow) - pos(b.goodLow), '#1f6f43', 'GOOD');
    this.zone(
      g, pos(b.perfectLow), barY, pos(b.perfectHigh) - pos(b.perfectLow),
      '#8c1646', 'PERFECT',
    );
    this.zone(g, pos(b.perfectHigh), barY, pos(b.spinHigh) - pos(b.perfectHigh), '#6e4a12', 'GREAT');
    this.zone(g, pos(b.spinHigh), barY, W - 4 - pos(b.spinHigh), '#7a2b26', 'BLOWN');

    // Needle.
    const nx = pos(snap.playerRpm);
    g.fillStyle = '#ffffff';
    g.fillRect(nx - 2, barY - 8, 4, barH + 16);
    g.fillStyle = 'rgba(255,255,255,0.22)';
    g.fillRect(nx - 1, barY - 4, 2, barH + 8);

    // Rev readout.
    g.font = '600 13px ui-monospace, monospace';
    g.fillStyle = 'rgba(232,238,247,0.9)';
    g.textAlign = 'left';
    g.fillText(`${Math.round(snap.playerRpm)} rpm`, 6, barY - 14);
    g.textAlign = 'right';
    g.fillText(`GEAR ${snap.playerGear}`, W - 6, barY - 14);

    // Countdown, huge, because it is the moment.
    if (snap.phase === 'COUNTDOWN' && snap.countdown > 0) {
      const n = Math.ceil(snap.countdown);
      g.font = '800 72px ui-sans-serif, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillStyle = n === 1 ? '#2ecc71' : 'rgba(232,238,247,0.92)';
      g.fillText(String(n), W / 2, barY - 30);
    }

    // Hold-too-long warning.
    if (snap.phase === 'STAGING' && snap.stageTime > 4) {
      g.font = '600 12px ui-sans-serif, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillStyle = '#e74c3c';
      g.fillText('CLUTCH OVERHEATING', W / 2, barY + barH + 16);
    }
  }

  private zone(
    g: CanvasRenderingContext2D,
    x: number, y: number, w: number, colour: string, label: string,
  ): void {
    if (w <= 0) return;
    g.fillStyle = colour;
    g.fillRect(x, y, w, 22);
    g.font = '700 9px ui-sans-serif, system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.textAlign = 'center';
    if (w > 34) g.fillText(label, x + w / 2, y + 15);
  }

  private drawResult(
    g: CanvasRenderingContext2D, W: number, H: number, snap: RaceSnapshot, now: number,
    rivalName: string,
  ): void {
    const p = snap.playerTiming;
    const r = snap.rivalTiming;
    if (!p.et) return;
    const grade = p.launch?.grade ?? '';
    if (grade !== this.lastGrade) {
      this.lastGrade = grade;
      this.flashUntil = now + 1400;
    }
    const won = snap.winner === 'player';

    g.textAlign = 'center';
    g.font = '800 40px ui-sans-serif, system-ui, sans-serif';
    g.fillStyle = won ? '#2ecc71' : '#e74c3c';
    g.fillText(won ? 'WIN' : snap.winner === 'rival' ? 'LOSE' : 'DRAW', W / 2, 46);

    g.font = '700 15px ui-monospace, monospace';
    g.fillStyle = 'rgba(232,238,247,0.95)';
    g.fillText(`YOU  ${p.et.toFixed(3)}s`, W / 2 - 80, 74);
    g.fillText(`${rivalName}  ${r.et.toFixed(3)}s`, W / 2 + 80, 74);

    if (p.launch) {
      const flash = now < this.flashUntil;
      g.font = '800 20px ui-sans-serif, system-ui, sans-serif';
      g.fillStyle = GRADE_COLOUR[p.launch.grade] ?? '#fff';
      if (flash) {
        g.shadowColor = g.fillStyle;
        g.shadowBlur = 18;
      }
      g.fillText(p.launch.grade, W / 2, 104);
      g.shadowBlur = 0;
      g.font = '600 12px ui-monospace, monospace';
      g.fillStyle = 'rgba(232,238,247,0.7)';
      g.fillText(`${p.launch.multiplier.toFixed(2)}x payout`, W / 2, 124);
    }

    g.font = '600 11px ui-monospace, monospace';
    g.fillStyle = 'rgba(232,238,247,0.55)';
    g.fillText('R to race again', W / 2, H - 10);
  }
}
