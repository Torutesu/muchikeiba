// REQ-A11Y-006 (contracts/protocol.md §41.5): the colour tokens of contracts/a11y-tokens.json.
//  - every token is readable on the navy panel (WCAG 2.x contrast: 3:1 for graphics, 4.5:1 for text tokens);
//  - in the colour-vision support mode (`cvd`) every group of cues (gauge levels, self vs others, ok vs danger) stays
//    apart by ΔE*ab (CIE76) ≥ 40 for normal vision and for simulated protanopia, deuteranopia and tritanopia
//    (Machado, Oliveira & Fernandes 2009, severity 1.0, applied in linear sRGB);
//  - the standard mode is today's look; the test records that its gauge / status pairs get close for a deutan viewer
//    (the reason the cvd mode exists).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tokens = JSON.parse(readFileSync(join(import.meta.dirname, '../../contracts/a11y-tokens.json'), 'utf8')) as {
  background: string; modes: Record<string, Record<string, string>>; groups: Record<string, string[]>; text: string[];
  rules: { minContrastGraphic: number; minContrastText: number; minDeltaE76Cvd: number; simulations: string[] };
};

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (h: string) => { const [r, g, b] = rgb(h).map(lin) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const MACHADO: Record<string, number[][]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
const simulate = (h: string, kind: string) => {
  const c = rgb(h).map(lin);
  const m = MACHADO[kind];
  if (!m) return c;
  return m.map((r) => Math.min(1, Math.max(0, r[0]! * c[0]! + r[1]! * c[1]! + r[2]! * c[2]!)));
};
const lab = ([r, g, b]: number[]) => {
  const X = (0.4124 * r! + 0.3576 * g! + 0.1805 * b!) / 0.95047, Y = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!, Z = (0.0193 * r! + 0.1192 * g! + 0.9505 * b!) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const deltaE = (a: string, b: string, kind: string) => { const p = lab(simulate(a, kind)), q = lab(simulate(b, kind)); return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!); };
const minGroupDistance = (mode: string, group: string, kind: string) => {
  const cols = tokens.groups[group]!.map((k) => tokens.modes[mode]![k]!);
  let min = Infinity;
  for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) min = Math.min(min, deltaE(cols[i]!, cols[j]!, kind));
  return min;
};

describe('REQ-A11Y-006 colour tokens (contracts/a11y-tokens.json)', () => {
  it('both modes define the same tokens, as sRGB hex', () => {
    const std = Object.keys(tokens.modes.standard!).sort();
    expect(Object.keys(tokens.modes.cvd!).sort()).toEqual(std);
    for (const m of Object.values(tokens.modes)) for (const v of Object.values(m)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    for (const g of Object.values(tokens.groups)) for (const k of g) expect(std).toContain(k);
  });
  it('the cyan accent and the navy tone are kept in the cvd mode (gauge ok = cyan)', () => {
    expect(tokens.modes.cvd!['gauge.ok']).toBe('#00d2ed');
    expect(tokens.background).toBe('#08182a');
  });
  it('every token reaches 3:1 on the navy panel, text tokens 4.5:1 (both modes)', () => {
    for (const [mode, m] of Object.entries(tokens.modes)) {
      for (const [k, v] of Object.entries(m)) {
        const min = tokens.text.includes(k) ? tokens.rules.minContrastText : tokens.rules.minContrastGraphic;
        expect(contrast(v, tokens.background), `${mode} ${k} ${v}`).toBeGreaterThanOrEqual(min);
      }
    }
  });
  it('cvd mode: every group stays ΔE*ab ≥ 40 apart for normal vision, protanopia, deuteranopia and tritanopia', () => {
    for (const g of Object.keys(tokens.groups)) for (const kind of tokens.rules.simulations) {
      expect(minGroupDistance('cvd', g, kind), `${g} ${kind}`).toBeGreaterThanOrEqual(tokens.rules.minDeltaE76Cvd);
    }
  });
  it('cvd mode is at least as distinguishable as standard for every group and simulation, and clearly better for a deutan viewer', () => {
    for (const g of Object.keys(tokens.groups)) for (const kind of tokens.rules.simulations.slice(1)) {
      expect(minGroupDistance('cvd', g, kind) + 1e-9, `${g} ${kind}`).toBeGreaterThanOrEqual(Math.min(minGroupDistance('standard', g, kind), tokens.rules.minDeltaE76Cvd));
    }
    // the reason for the mode: today's yellow / red gauge and green / red status get close for deuteranopia
    expect(minGroupDistance('standard', 'gauge', 'deutan')).toBeLessThan(tokens.rules.minDeltaE76Cvd);
    expect(minGroupDistance('standard', 'status', 'deutan')).toBeLessThan(tokens.rules.minDeltaE76Cvd);
    expect(minGroupDistance('cvd', 'gauge', 'deutan')).toBeGreaterThan(minGroupDistance('standard', 'gauge', 'deutan') + 15);
  });
  it('the contrast helper matches the WCAG reference values', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
});
