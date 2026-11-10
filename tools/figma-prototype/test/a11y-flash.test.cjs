// Round 15 (REQ-A11Y-006/007/008, contracts/protocol.md §41.5–41.6): static checks of the prototype's stylesheet and app.
//  1) the --a11y-* colour variables equal contracts/a11y-tokens.json (standard on :root, cvd on html[data-color-mode="cvd"]);
//  2) every repeating animation (CSS `infinite`) flashes at most 3 times a second: one light-dark pair per period,
//     per two periods with `alternate` (WCAG 2.3.1 general flash threshold);
//  3) every repeating animation is switched off by reduce motion (an html[data-reduce-motion="on"] rule for its selector);
//  4) the one-shot lights (flash()) go through the 3-per-second limiter, and every vibration goes through haptic().
// usage: node tools/figma-prototype/test/a11y-flash.test.cjs
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const root = path.join(__dirname, '..', '..', '..');
const css = fs.readFileSync(path.join(__dirname, '..', 'site', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const app = fs.readFileSync(path.join(__dirname, '..', 'site', 'app.js'), 'utf8');
const tokens = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'a11y-tokens.json'), 'utf8'));

// top-level rules (keyframes removed)
const flat = css.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
const rules = [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const vars = (sel) => {
  const out = {};
  for (const r of rules.filter((x) => x.sel === sel)) for (const m of r.body.matchAll(/--a11y-([\w.-]+)\s*:\s*(#[0-9a-f]{6})/gi)) out[m[1]] = m[2].toLowerCase();
  return out;
};
// 1) tokens
const want = (mode) => Object.fromEntries(Object.entries(tokens.modes[mode]).map(([k, v]) => [k.replace('.', '-'), v]));
assert.deepEqual(vars(':root'), want('standard'), 'standard tokens on :root equal contracts/a11y-tokens.json');
assert.deepEqual(vars('html[data-color-mode="cvd"]'), want('cvd'), 'cvd tokens equal contracts/a11y-tokens.json');

// 2) flash rate of every repeating animation
const repeating = [];
for (const r of rules) {
  for (const m of r.body.matchAll(/animation\s*:\s*([^;]+);?/g)) {
    const decl = m[1];
    if (!/\binfinite\b/.test(decl)) continue;
    const name = decl.trim().split(/\s+/)[0];
    const dur = /([\d.]+)(ms|s)\b/.exec(decl);
    assert.ok(dur, 'a duration for ' + decl);
    const seconds = parseFloat(dur[1]) / (dur[2] === 'ms' ? 1000 : 1);
    const alternate = /\balternate\b/.test(decl);
    const rate = 1 / (seconds * (alternate ? 2 : 1));
    repeating.push({ sel: r.sel, name, seconds, alternate, rate });
    assert.ok(rate <= 3, `${r.sel}: ${name} flashes ${rate.toFixed(2)}/s (> 3)`);
  }
}
assert.ok(repeating.length >= 4, 'found the HUD blinks: ' + repeating.map((x) => x.name).join(', '));

// 3) reduce motion switches each of them off
const reducedSel = rules.filter((r) => r.sel.includes('html[data-reduce-motion="on"]') && /animation\s*:\s*none/.test(r.body))
  .flatMap((r) => r.sel.split(',').map((x) => x.replace('html[data-reduce-motion="on"]', '').trim()));
for (const x of repeating) for (const part of x.sel.split(',').map((y) => y.trim())) {
  assert.ok(reducedSel.includes(part), `reduce motion stops "${part}" (${x.name})`);
}
assert.ok(/html\[data-reduce-motion="on"\] \.screen\.in \.art\.drift \{ animation: none; \}/.test(css), 'reduce motion: no background drift');
assert.ok(/html\[data-reduce-motion="on"\] \.speedlines \{ display: none; \}/.test(css), 'reduce motion: no speed lines');

// 4) the app: limiter, haptics, reveal, kick
assert.ok(/function flash\([^)]*\) \{[\s\S]{0,200}if \(!flashOk\(\)\) return;/.test(app), 'flash() asks the limiter');
assert.ok(!/navigator\.vibrate\?\.\((?!pattern)/.test(app.replace(/function haptic[^\n]*\n/, '')), 'every vibration goes through haptic()');
assert.ok(/setTimeout\(face, reduced\(\) \? 0 : 380\)/.test(app), 'the scout reveal skips its glow wait with reduce motion');
assert.ok(/if \(departed && !reduced\(\)\) \{ view\.kick\(\)/.test(app), 'no FOV kick / speed lines with reduce motion');
// 5) Round 14 / 15 screens (integration): every one-shot motion of the hall ceremony (.hof-*), photo mode (.ph-*), activity
//    (.act-*), the advice panel (.adv-*), my replays (.rp-*) and the silks editor (.silk-*) has a reduce-motion rule that
//    stops it or turns it into a short fade; photo mode never lights the screen (no flash() in the photo code).
const r15 = /\.(hof|ph|act|adv|rp|silk)-[\w-]+/;
const reducedAny = rules.filter((r) => r.sel.includes('html[data-reduce-motion="on"]') && /animation\s*:\s*(none|fade\s+\.1\d?s)/.test(r.body))
  .flatMap((r) => r.sel.split(',').map((x) => x.replace('html[data-reduce-motion="on"]', '').trim()));
const oneShots = rules.filter((r) => r15.test(r.sel) && !r.sel.includes('data-reduce-motion') && /animation\s*:\s*(?!none)[\w-]+/.test(r.body));
for (const r of oneShots) for (const part of r.sel.split(',').map((y) => y.trim()).filter((y) => r15.test(y))) {
  assert.ok(reducedAny.includes(part), `reduce motion stops the one-shot motion of "${part}"`);
}
const photoCode = app.slice(app.indexOf('const PH_TABS'), app.indexOf('// ================================================================= boot'));
assert.ok(photoCode.length > 1000 && !/\bflash\(/.test(photoCode), 'photo mode never flashes the screen');
console.log('flash rates: ' + repeating.map((x) => `${x.name} ${x.rate.toFixed(2)}/s`).join(', '));
console.log('A11Y FLASH / TOKENS OK');
