import { describe, it, expect } from 'vitest';
import puppeteer, { type Page } from 'puppeteer';

const PORT = 5199;

/** Launch headless Chrome with a real (software-rasterised) GL2 context. */
async function withPage(fn: (page: Page) => Promise<string[]>): Promise<string[]> {
  const browser = await puppeteer.launch({
    headless: 'shell' as never,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  try {
    const page = await browser.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/**
 * GL errors are silent in production: a dropped draw just means the frame is
 * subtly wrong, so the only way to catch them is to scrape the console. These
 * are the strings a driver emits when a draw is discarded.
 */
const GL_FAILURE = /INVALID_|Feedback loop|compile failed|link failed|WebGL:/;

async function waitForApp(page: Page): Promise<void> {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__CAUSTIC_TEST__ && window.__CAUSTIC_TEST__.ready', {
    timeout: 150000,
  });
}

function collectGlProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m: { type: () => string; text: () => string }) => {
    const t = m.text();
    if (GL_FAILURE.test(t)) problems.push(t.slice(0, 300));
  });
  page.on('pageerror', (e: unknown) => {
    problems.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`);
  });
  return problems;
}

describe('the renderer on a real GL context', () => {
  it('compiles every shader and produces frames with no GL errors', async () => {
    await withPage(async (page) => {
      const problems = collectGlProblems(page);
      await waitForApp(page);

      const result = (await page.evaluate(
        () => (window as unknown as Record<string, unknown>).__CAUSTIC_TEST__,
      )) as { error?: string; frames: number; drawCalls: number; tier: string };

      expect(result.error ?? '', 'renderer must not report an error').toBe('');
      expect(result.frames, 'frames were rendered').toBeGreaterThan(2);
      expect(result.drawCalls, 'the draw list is not empty').toBeGreaterThan(0);
      expect(problems, `GL problems:\n${problems.join('\n')}`).toHaveLength(0);
      return problems;
    });
  }, 300000);

  it('runs at every quality tier without a GL error', async () => {
    await withPage(async (page) => {
      const problems = collectGlProblems(page);
      await waitForApp(page);

      // Each tier allocates different targets and runs different passes, so
      // every one is a separate code path that has to be clean.
      for (const tier of ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'] as const) {
        const applied = await page.evaluate((t: string) => {
          const app = (
            window as unknown as Record<string, unknown>
          ).__CAUSTIC_APP__ as { renderer: { setTier: (x: string) => void; tier: string } } | undefined;
          if (!app) return false;
          app.renderer.setTier(t);
          return app.renderer.tier === t;
        }, tier);
        expect(applied, `tier ${tier} applied`).toBe(true);
        await new Promise((r) => setTimeout(r, 1500));
      }
      expect(problems, `GL problems:\n${problems.join('\n')}`).toHaveLength(0);
      return problems;
    });
  }, 420000);

  it('writes a non-trivial image to the canvas', async () => {
    await withPage(async (page) => {
      const problems = collectGlProblems(page);
      await waitForApp(page);

      // Read the back buffer from INSIDE the render loop. The context is
      // created without preserveDrawingBuffer so the shipping path stays fast,
      // which means the pixels are gone once the frame is composited.
      const stats = (await page.evaluate(async () => {
        const w = window as unknown as Record<string, unknown>;
        w.__CAUSTIC_STATS__ = null;
        w.__CAUSTIC_READBACK__ = true;
        const deadline = Date.now() + 20000;
        while (!w.__CAUSTIC_STATS__ && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        return w.__CAUSTIC_STATS__;
      })) as { min: number; max: number; mean: number; distinct: number } | null;

      expect(stats, 'the renderer never produced a readback').not.toBeNull();
      if (!stats) return problems;
      // A renderer that draws nothing still logs no errors, so assert on pixels:
      // not black, real contrast, not blown out, and more than a flat fill.
      expect(stats.max, 'image is not entirely black').toBeGreaterThan(8);
      expect(stats.max - stats.min, 'image has real contrast').toBeGreaterThan(24);
      expect(stats.mean, 'image is not fully dark').toBeGreaterThan(2);
      expect(stats.mean, 'image is not blown out').toBeLessThan(240);
      expect(stats.distinct, 'image has tonal variety').toBeGreaterThan(6);
      expect(problems, `GL problems:\n${problems.join('\n')}`).toHaveLength(0);
      return problems;
    });
  }, 300000);
});
