// FTUE timing for the e2e walkthrough (test/unity-flow.cjs): how long a new player waits for each milestone, measured on
// the app's own clock and robust to a CPU-starved test machine. The §2.3 targets (docs/planning/06 §2.3) are unchanged;
// only what the harness itself adds is left out, and each part is reported so nothing is hidden:
//   - the milestone time is when the APP showed the screen (site/app.js screenLog, performance.now), not when the harness
//     noticed it (a waitForFunction poll can be seconds late under load);
//   - a navigation tap counts the scripted think time (THINK_MS) and then the app's reaction from the moment the tap
//     reached the page (a pointerdown listener, page clock). The time Playwright took between the think time and
//     delivering the tap (actionability checks that wait on a starved renderer: 3–10 s on a loaded 4-core box, ~0.1 s
//     quiet) is the harness's, not the player's: "tap delivery";
//   - a race counts its engine time (ticks × 50 ms), not the wall time a starved renderer took to draw it ("render lag",
//     measured by the caller as before);
//   - screenshots outside races are the harness's ("capture", as before);
//   - "starve": while the player is waiting on the app, the time the page's renderer main thread spent RUNNABLE BUT NOT
//     RUNNING because other processes held every CPU (Linux /proc/<pid>/task/<pid>/schedstat, field 2: run-queue wait).
//     Its work (on-CPU time) and its waits (network, timers, animations) still count in full; a phone running only
//     this app has no such queue. Only renderer main threads are counted (a starved GPU or compositor thread still
//     counts against the target, so this never over-corrects). 0 where /proc is not available.
// All instants are real epoch milliseconds (performance.timeOrigin + performance.now() on both sides), so a shifted
// Date (the fake-clock preloads used for date sweeps) does not affect the measurement.
const fs = require('fs');

const nowE = () => performance.timeOrigin + performance.now();

/** Sum of run-queue waits (ms) of the main threads of the given renderer processes, or null without /proc. */
function runQueueMs(pids) {
  let sum = 0, any = false;
  for (const pid of pids) {
    try { sum += Number(fs.readFileSync(`/proc/${pid}/task/${pid}/schedstat`, 'utf8').split(' ')[1]) / 1e6; any = true; } catch { /* gone or no /proc */ }
  }
  return any ? sum : null;
}

module.exports = async function ftueTiming(browser, ctx) {
  // the page clock of each tap that reached the document (capture phase, before any app handler)
  await ctx.addInitScript(() => { globalThis.__ftueTaps = []; document.addEventListener('pointerdown', () => globalThis.__ftueTaps.push(performance.now()), true); });
  let cdp = null;
  try { cdp = await browser.newBrowserCDPSession(); } catch { /* not chromium */ }
  // renderer main-thread run-queue time, sampled every 100 ms: [epoch, cumulative ms per pid]
  const samples = [];
  let pids = [], lastPids = 0, timer = null, busy = false;
  const sample = async () => {
    if (busy) return; busy = true;
    try {
      if (cdp && nowE() - lastPids > 1000) {
        lastPids = nowE();
        try { pids = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer').map((p) => p.id); } catch { pids = []; }
      }
      const per = {};
      for (const pid of pids) { const v = runQueueMs([pid]); if (v !== null) per[pid] = v; }
      samples.push([nowE(), per]);
    } finally { busy = false; }
  };
  // run-queue ms in [a, b] from the samples (per pid: last sample ≤ b minus last sample ≤ a; a pid born inside counts from 0)
  const rqBetween = (a, b) => {
    const at = (t) => { let s = null; for (const x of samples) { if (x[0] <= t) s = x; else break; } return s?.[1] ?? {}; };
    const A = at(a), B = at(b);
    return Object.entries(B).reduce((sum, [pid, v]) => sum + Math.max(0, v - (A[pid] ?? 0)), 0);
  };

  const excluded = { capture: [], tap: [], player: [], race: [] }; // [from, to] epochs; race: [from, to, lagMs]
  let t0 = null;
  return {
    nowE,
    start() { t0 = nowE(); samples.length = 0; void sample(); timer = setInterval(sample, 100); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    capture(a, b) { excluded.capture.push([a, b]); },
    /** the scripted think time [a, b] (the player's own time: counted, never corrected) and the tap delivery after it */
    tap(thinkFrom, thinkTo, reachedPage) { excluded.player.push([thinkFrom, thinkTo]); if (reachedPage > thinkTo) excluded.tap.push([thinkTo, reachedPage]); },
    race(a, b, lagMs) { excluded.race.push([a, b, Math.max(0, lagMs)]); },
    /** the page clock's latest tap as an epoch (null when none reached the page since `count` taps) */
    async lastTap(page, count) {
      const r = await page.evaluate(() => ({ o: performance.timeOrigin, t: globalThis.__ftueTaps ?? [] }));
      return r.t.length > count ? r.o + r.t[r.t.length - 1] : null;
    },
    tapCount: (page) => page.evaluate(() => (globalThis.__ftueTaps ?? []).length),
    /** the app's own time for `screen` shown last at or before `notAfter` (epoch), from site/app.js screenLog */
    async shownAt(page, screen, notAfter) {
      const r = await page.evaluate(() => ({ o: performance.timeOrigin, s: globalThis.__muchi?.screenLog?.() ?? [] }));
      let best = null;
      for (const [name, t] of r.s) if (name === screen && r.o + t <= notAfter + 1) best = r.o + t;
      return best;
    },
    /** the player's time to the instant `e` and its parts (all ms) */
    measure(e) {
      const clip = ([a, b]) => Math.max(0, Math.min(b, e) - Math.max(a, t0));
      const capture = excluded.capture.reduce((s, x) => s + clip(x), 0);
      const tap = excluded.tap.reduce((s, x) => s + clip(x), 0);
      const lag = excluded.race.filter((x) => x[1] <= e).reduce((s, x) => s + x[2], 0);
      // the app-wait windows: [t0, e] minus think time, tap delivery, races and captures
      const cuts = [...excluded.capture, ...excluded.tap, ...excluded.player, ...excluded.race.map((x) => [x[0], x[1]])].map(([a, b]) => [Math.max(a, t0), Math.min(b, e)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
      let starve = 0, from = t0;
      for (const [a, b] of cuts) { if (a > from) starve += rqBetween(from, a); from = Math.max(from, b); }
      if (e > from) starve += rqBetween(from, e);
      const wall = e - t0;
      return { ms: Math.round(wall - capture - tap - lag - starve), wallMs: Math.round(wall), captureMs: Math.round(capture), tapLagMs: Math.round(tap), lagMs: Math.round(lag), starveMs: Math.round(starve) };
    },
  };
};
