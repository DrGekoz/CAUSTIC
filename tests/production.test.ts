import { it, expect } from 'vitest';
import puppeteer, { type Page, type Browser } from 'puppeteer';
import { createServer, type Server } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The production bundle is a release gate.
 *
 * Every other render test runs against the dev server, which happily serves
 * unbundled ES modules and resolves imports at runtime. The shipped artefact is
 * a single minified file with hashed asset names, and the failure modes there --
 * a stripped export, a bad asset path, a tree-shaken side effect -- are
 * invisible until it is actually built and loaded from disk.
 */

const ROOT = 'F:/aaaaaVIBECODING/CAUSTIC';
const DIST = join(ROOT, 'dist');
const PORT = 5299;
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Build once for the whole file. */
function build(): void {
  execFileSync('node', [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: ROOT,
    stdio: 'pipe',
  });
}

function serveDist(): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const url = (req.url ?? '/').split('?')[0];
      // Strip a leading slash BEFORE joining: normalize() treats a leading
      // slash as filesystem root and discards the drive letter on Windows.
      const rel = normalize(url).replace(/^[/\\]+/, '');
      let p = join(DIST, rel === '' ? 'index.html' : rel);
      const st = await stat(p).catch(() => null);
      if (!st || st.isDirectory()) p = join(DIST, 'index.html');
      const body = await readFile(p);
      res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function openProd(browser: Browser): Promise<{ page: Page; problems: string[] }> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const problems: string[] = [];
  page.on('pageerror', (e: unknown) => {
    problems.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`);
  });
  page.on('console', (m: { text: () => string }) => {
    const t = m.text();
    if (/INVALID_|Feedback loop|compile failed|WebGL:|Uncaught/.test(t)) problems.push(t.slice(0, 240));
  });
  page.on('requestfailed', (r: { url: () => string }) => {
    problems.push(`request failed: ${r.url()}`);
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  return { page, problems };
}

const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

it('the production bundle boots and completes a race', async () => {
  await mkdir(DIST, { recursive: true });
  build();

  const server = await serveDist();
  const browser = await puppeteer.launch({ headless: 'shell' as never, args: LAUNCH_ARGS });
  try {
    const { page, problems } = await openProd(browser);
    await page.waitForFunction(
      'window.__CAUSTIC_TEST__ && window.__CAUSTIC_TEST__.ready',
      { timeout: 120000 },
    );

    // Drive the whole sequence: staging, countdown, race, finish. Stepping
    // only RACING leaves the race parked at STAGING forever.
    const result = await page.evaluate(async () => {
      const app = (window as unknown as Record<string, unknown>).__CAUSTIC_APP__ as {
        update: (dt: number) => void;
        race: { phase: string; snapshot: () => Record<string, unknown> };
      };
      // Drive through app.update(), not race.step(): the app owns the input
      // path, including the autopilot that drives a player who is not pressing
      // anything. Stepping the race directly would bypass both and test a
      // different game than the one that ships.
      const FIXED = 1 / 240;
      let n = 0;
      while (app.race.phase !== 'FINISHED' && n < 240 * 60) {
        app.update(FIXED);
        n++;
      }
      const s = app.race.snapshot();
      const p = s.playerTiming as { et: number; launch?: { grade: string } };
      const r = s.rivalTiming as { et: number };
      return {
        phase: app.race.phase, winner: s.winner, pEt: p.et, rEt: r.et,
        grade: p.launch?.grade, steps: n, pDist: s.playerDistance,
      };
    });

    // The bundle must run the same code as the dev server.
    expect(result.phase, `a full race should complete (${JSON.stringify(result)})`).toBe('FINISHED');
    expect(result.pEt).toBeGreaterThan(8);
    expect(result.pEt).toBeLessThan(40);
    expect(result.rEt).toBeGreaterThan(8);
    expect(result.grade).toBeDefined();
    expect(problems, `production console must be clean:\n${problems.join('\n')}`).toEqual([]);
  } finally {
    await browser.close();
    server.close();
  }
}, 600000);