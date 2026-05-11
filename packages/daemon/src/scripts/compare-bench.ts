/**
 * Compare two bench-results-*.json files and print a side-by-side report.
 *
 * Usage:
 *   npx ts-node src/scripts/compare-bench.ts bench-results-master.json bench-results-branch.json
 */
import * as fs from 'fs';

interface Stats { n: number; min: number; p50: number; p95: number; max: number; mean: number }
interface Result {
  opts: any;
  totalMs: Stats;
  perSpan: Record<string, Stats>;
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits).padStart(8);
}

function pct(before: number, after: number): string {
  if (before === 0) return '  n/a';
  const delta = ((after - before) / before) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

function speedup(before: number, after: number): string {
  if (after === 0) return '∞';
  return `${(before / after).toFixed(2)}x`;
}

function main() {
  const [masterFile, branchFile] = process.argv.slice(2);
  if (!masterFile || !branchFile) {
    console.error('Usage: compare-bench <master.json> <branch.json>');
    process.exit(1);
  }

  const master: Result = JSON.parse(fs.readFileSync(masterFile, 'utf-8'));
  const branch: Result = JSON.parse(fs.readFileSync(branchFile, 'utf-8'));

  console.log(`\n## voidTx Benchmark — master vs perf/batch-void-tx-queries`);
  console.log(`Scenario: inputs=${branch.opts.inputs}  address-token pairs=${branch.opts.pairs}  runs=${branch.opts.runs}  warmup=${branch.opts.warmup}`);
  console.log(`MySQL: localhost:3306 (docker-compose.dev.yml)  OTel: enabled, exported to Jaeger\n`);

  console.log('### Total voidTx wall-clock (ms)');
  console.log('               | master     | branch     | delta      | speedup');
  console.log('---------------|------------|------------|------------|--------');
  const mT = master.totalMs;
  const bT = branch.totalMs;
  const row = (label: string, m: number, b: number) =>
    console.log(`${label.padEnd(14)} |${fmt(m)}   |${fmt(b)}   | ${pct(m, b).padStart(9)}  | ${speedup(m, b)}`);
  row('mean',  mT.mean, bT.mean);
  row('p50',   mT.p50,  bT.p50);
  row('p95',   mT.p95,  bT.p95);
  row('min',   mT.min,  bT.min);
  row('max',   mT.max,  bT.max);

  console.log('\n### Per-span mean duration (ms) — summed within a run');
  console.log('span                           | master     | branch     | delta      | speedup');
  console.log('-------------------------------|------------|------------|------------|--------');
  const allSpans = new Set<string>([...Object.keys(master.perSpan), ...Object.keys(branch.perSpan)]);
  // Sort by master mean descending
  const sorted = Array.from(allSpans).sort((a, b) => {
    const am = master.perSpan[a]?.mean ?? 0;
    const bm = master.perSpan[b]?.mean ?? 0;
    return bm - am;
  });
  for (const span of sorted) {
    const m = master.perSpan[span]?.mean ?? 0;
    const b = branch.perSpan[span]?.mean ?? 0;
    console.log(
      `${span.padEnd(30)} |${fmt(m)}   |${fmt(b)}   | ${pct(m, b).padStart(9)}  | ${speedup(m, b)}`,
    );
  }

  console.log('\nInterpretation: delta negative + speedup > 1 means the branch is faster.');
}

main();
