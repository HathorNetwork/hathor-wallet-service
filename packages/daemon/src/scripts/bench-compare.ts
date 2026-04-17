/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Bench comparator.
 *
 * Reads two bench-results JSON files (produced by bench-sync.ts) and emits a
 * markdown report comparing per-metric medians. A 95% confidence interval on
 * the median delta is computed via bootstrap resampling — a single point
 * estimate would be misleading at the run counts this harness produces.
 *
 * This tool is informational only. It does not exit non-zero on regression;
 * CI runner variance is too high for a hard gate to be useful. Emit to
 * stdout, pipe to `gh pr comment`.
 *
 * Usage:
 *   yarn bench:compare --baseline bench-results-master.json --candidate bench-results-branch.json
 *   yarn bench:compare --baseline a.json --candidate b.json --bootstrap 10000
 */

import { readFileSync } from 'node:fs';

interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
  samples: number[];
}

interface BenchOutput {
  opts: {
    scenario: string;
    port: number;
    lastEvent: number;
    runs: number;
    warmup: number;
    label: string;
  };
  totalMs: Summary | null;
  perSpan: Record<string, Summary | null>;
}

interface Opts {
  baseline: string;
  candidate: string;
  bootstrap: number;
  seed: number;
}

function parseArgs(): Opts {
  const args = process.argv.slice(2);
  const opts: Opts = {
    baseline: '',
    candidate: '',
    bootstrap: 10000,
    seed: 42,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    switch (a) {
      case '--baseline': opts.baseline = v; i++; break;
      case '--candidate': opts.candidate = v; i++; break;
      case '--bootstrap': opts.bootstrap = parseInt(v, 10); i++; break;
      case '--seed': opts.seed = parseInt(v, 10); i++; break;
      case '--help':
      case '-h':
        console.log(`Usage: bench-compare --baseline <a.json> --candidate <b.json> [--bootstrap 10000] [--seed 42]`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown arg: ${a}`);
        process.exit(1);
    }
  }
  if (!opts.baseline || !opts.candidate) {
    console.error('Both --baseline and --candidate are required');
    process.exit(1);
  }
  return opts;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Mulberry32 — small, deterministic PRNG. Good enough for bootstrap resampling. */
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resample(values: number[], rng: () => number): number[] {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = values[Math.floor(rng() * values.length)];
  }
  return out;
}

interface CompareResult {
  metric: string;
  baselineP50: number;
  candidateP50: number;
  deltaPct: number;
  ciLowPct: number;
  ciHighPct: number;
  flag: '🟢' | '🔴' | '⚪' | '⚠️';
  note?: string;
}

function compareSamples(
  metric: string,
  baseline: number[],
  candidate: number[],
  bootstrap: number,
  rng: () => number,
): CompareResult {
  const baselineP50 = median(baseline);
  const candidateP50 = median(candidate);

  if (baselineP50 === 0 || Number.isNaN(baselineP50)) {
    return {
      metric,
      baselineP50,
      candidateP50,
      deltaPct: NaN,
      ciLowPct: NaN,
      ciHighPct: NaN,
      flag: '⚠️',
      note: 'baseline median is 0/NaN',
    };
  }

  const deltaPct = ((candidateP50 - baselineP50) / baselineP50) * 100;

  // Bootstrap 95% CI on the median delta %.
  const deltas = new Array(bootstrap);
  for (let i = 0; i < bootstrap; i++) {
    const b = median(resample(baseline, rng));
    const c = median(resample(candidate, rng));
    deltas[i] = b === 0 ? NaN : ((c - b) / b) * 100;
  }
  deltas.sort((a, b) => a - b);
  const ciLowPct = deltas[Math.floor(0.025 * bootstrap)];
  const ciHighPct = deltas[Math.floor(0.975 * bootstrap)];

  let flag: CompareResult['flag'] = '⚪';
  if (ciHighPct < 0) flag = '🟢';
  else if (ciLowPct > 0) flag = '🔴';

  return { metric, baselineP50, candidateP50, deltaPct, ciLowPct, ciHighPct, flag };
}

function fmtMs(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  if (v >= 100) return v.toFixed(1);
  if (v >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function renderTable(results: CompareResult[]): string {
  const lines = [
    '| metric | baseline p50 (ms) | candidate p50 (ms) | Δ | 95% CI | |',
    '|---|---:|---:|---:|---|:---:|',
  ];
  for (const r of results) {
    const ci = Number.isFinite(r.ciLowPct) && Number.isFinite(r.ciHighPct)
      ? `[${fmtPct(r.ciLowPct)}, ${fmtPct(r.ciHighPct)}]`
      : 'n/a';
    const note = r.note ? ` *(${r.note})*` : '';
    lines.push(
      `| ${r.metric} | ${fmtMs(r.baselineP50)} | ${fmtMs(r.candidateP50)} | ${fmtPct(r.deltaPct)} | ${ci} | ${r.flag}${note} |`,
    );
  }
  return lines.join('\n');
}

function main() {
  const opts = parseArgs();
  const baseline: BenchOutput = JSON.parse(readFileSync(opts.baseline, 'utf8'));
  const candidate: BenchOutput = JSON.parse(readFileSync(opts.candidate, 'utf8'));

  if (baseline.opts.scenario !== candidate.opts.scenario) {
    console.error(`⚠️  Scenario mismatch: baseline=${baseline.opts.scenario} candidate=${candidate.opts.scenario}`);
    process.exit(1);
  }

  const rng = mulberry32(opts.seed);
  const results: CompareResult[] = [];

  if (baseline.totalMs && candidate.totalMs) {
    results.push(
      compareSamples('totalMs', baseline.totalMs.samples, candidate.totalMs.samples, opts.bootstrap, rng),
    );
  }

  const allSpanNames = new Set([
    ...Object.keys(baseline.perSpan),
    ...Object.keys(candidate.perSpan),
  ]);
  const spanNames = [...allSpanNames].sort();
  for (const name of spanNames) {
    const b = baseline.perSpan[name];
    const c = candidate.perSpan[name];
    if (!b || !c) {
      results.push({
        metric: name,
        baselineP50: b?.p50 ?? NaN,
        candidateP50: c?.p50 ?? NaN,
        deltaPct: NaN,
        ciLowPct: NaN,
        ciHighPct: NaN,
        flag: '⚠️',
        note: b ? 'missing in candidate' : 'missing in baseline',
      });
      continue;
    }
    results.push(compareSamples(name, b.samples, c.samples, opts.bootstrap, rng));
  }

  const greens = results.filter((r) => r.flag === '🟢').length;
  const reds = results.filter((r) => r.flag === '🔴').length;
  const noise = results.filter((r) => r.flag === '⚪').length;
  const warn = results.filter((r) => r.flag === '⚠️').length;

  console.log('## Sync benchmark comparison');
  console.log('');
  console.log(`**Scenario:** \`${baseline.opts.scenario}\` (${baseline.opts.lastEvent} events)  `);
  console.log(`**Runs:** baseline=${baseline.opts.runs} (label: \`${baseline.opts.label}\`), candidate=${candidate.opts.runs} (label: \`${candidate.opts.label}\`), warmup=${baseline.opts.warmup}/${candidate.opts.warmup}  `);
  console.log(`**Bootstrap samples:** ${opts.bootstrap}, seed: ${opts.seed}  `);
  console.log(`**Verdict:** 🟢 ${greens} improvement${greens === 1 ? '' : 's'} · 🔴 ${reds} regression${reds === 1 ? '' : 's'} · ⚪ ${noise} noise · ⚠️ ${warn} skipped`);
  console.log('');
  console.log(renderTable(results));
  console.log('');
  console.log('_🟢/🔴 mean the 95% CI is fully on one side of 0. ⚪ means the CI crosses 0 — the difference is indistinguishable from noise at this run count. This report is informational only; CI runner variance makes hard gates unreliable at the run counts we can afford in CI._');
}

main();
