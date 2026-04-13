/**
 * Benchmark harness for voidTx performance.
 *
 * Seeds a synthetic large voidable transaction (N inputs, M address-token pairs),
 * calls voidTx K times (re-seeding between runs), and records OTel span durations.
 *
 * Usage:
 *   export DB_ENDPOINT=localhost DB_NAME=wallet_service DB_USER=hathor DB_PASS=hathor DB_PORT=3306
 *   export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # optional, for Jaeger viz
 *   npx ts-node src/scripts/bench-void-tx.ts --inputs 200 --pairs 200 --runs 10 --label branch
 *
 * Writes JSON result to ./bench-results-<label>.json
 */

// -------------------------------------------------------------------
// OTel setup — MUST happen before importing services/db modules
// so that the provider is registered when those modules cache the tracer.
// -------------------------------------------------------------------
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';

// In-memory span collector
const collectedSpans: Array<{ name: string; durationMs: number; traceId: string }> = [];

class InMemoryCollector implements SpanProcessor {
  onStart() { /* no-op */ }
  onEnd(span: ReadableSpan) {
    const [s, ns] = span.duration;
    const durationMs = s * 1000 + ns / 1e6;
    collectedSpans.push({
      name: span.name,
      durationMs,
      traceId: span.spanContext().traceId,
    });
  }
  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

const sdkProcessors: SpanProcessor[] = [new InMemoryCollector()];
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  sdkProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter(), {
    maxQueueSize: 4096,
    maxExportBatchSize: 512,
    scheduledDelayMillis: 1000,
    exportTimeoutMillis: 5000,
  }));
}

// Compose processors — fan out span events to every processor in the array.
class MultiSpanProcessor implements SpanProcessor {
  constructor(private processors: SpanProcessor[]) {}
  onStart(span: any, ctx: any) { this.processors.forEach((p) => p.onStart(span, ctx)); }
  onEnd(span: ReadableSpan) { this.processors.forEach((p) => p.onEnd(span)); }
  async forceFlush() { await Promise.all(this.processors.map((p) => p.forceFlush())); }
  async shutdown() { await Promise.all(this.processors.map((p) => p.shutdown())); }
}

const sdk = new NodeSDK({
  resource: new Resource({
    'service.name': 'bench-void-tx',
    'deployment.environment': 'bench',
  }),
  spanProcessor: new MultiSpanProcessor(sdkProcessors),
});
sdk.start();

// -------------------------------------------------------------------
// Now safe to import daemon modules
// -------------------------------------------------------------------
// eslint-disable-next-line import/first
import * as mysql2 from 'mysql2/promise';
// eslint-disable-next-line import/first
import { voidTx } from '../services';
// eslint-disable-next-line import/first
import { EventTxInput, EventTxOutput } from '../types';

// -------------------------------------------------------------------
// CLI parsing
// -------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { inputs: 200, pairs: 200, runs: 10, label: 'run', warmup: 1 };
  for (let i = 0; i < args.length; i++) {
    const [k, v] = [args[i], args[i + 1]];
    if (k === '--inputs') { opts.inputs = parseInt(v, 10); i++; }
    else if (k === '--pairs') { opts.pairs = parseInt(v, 10); i++; }
    else if (k === '--runs') { opts.runs = parseInt(v, 10); i++; }
    else if (k === '--label') { opts.label = v; i++; }
    else if (k === '--warmup') { opts.warmup = parseInt(v, 10); i++; }
  }
  return opts;
}

// -------------------------------------------------------------------
// DB helpers
// -------------------------------------------------------------------
async function getConn() {
  return mysql2.createConnection({
    host: process.env.DB_ENDPOINT || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'hathor',
    password: process.env.DB_PASS || 'hathor',
    database: process.env.DB_NAME || 'wallet_service',
    multipleStatements: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
}

async function cleanDb(conn: mysql2.Connection) {
  const tables = [
    'wallet_tx_history', 'wallet_balance', 'wallet',
    'address_tx_history', 'address_balance', 'address',
    'tx_output', 'transaction', 'token',
    'token_creation', 'tx_proposal',
  ];
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) {
    await conn.query(`DELETE FROM \`${t}\``);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
}

// Generate deterministic 64-char hex from numeric id.
// Pad n to fixed width FIRST so different n values can't collide when right-padded.
function hashFor(prefix: string, n: number): string {
  const base = `${prefix}${String(n).padStart(10, '0')}`;
  return base.padEnd(64, 'a').slice(0, 64);
}

function addrFor(n: number): string {
  // Hathor addresses are 34 chars base58. Anything 34-ish works for our tables.
  return `Haddr${String(n).padStart(29, '0')}`;
}

function tokenFor(n: number): string {
  // Use native token for half, synthetic for half — matches realistic workload.
  if (n % 2 === 0) return '00';
  return hashFor('tok', n);
}

interface ScenarioFixtures {
  targetHash: string;
  inputs: EventTxInput[];
  outputs: EventTxOutput[];
  tokens: string[];
}

async function seedScenario(
  conn: mysql2.Connection,
  opts: { inputs: number; pairs: number },
): Promise<ScenarioFixtures> {
  const targetHash = hashFor('target', 1);
  const now = Math.floor(Date.now() / 1000);

  // --- Target transaction row
  await conn.query(
    `INSERT INTO \`transaction\` (tx_id, timestamp, version, voided, height, weight, first_block)
     VALUES (?, ?, 1, FALSE, NULL, 1.0, NULL)`,
    [targetHash, now],
  );

  // --- Previous transactions (one per input) + their UTXOs (spent by target)
  // Build batched INSERTs to keep seed fast.
  const prevTxRows: any[] = [];
  const prevUtxoRows: any[] = [];
  const inputs: EventTxInput[] = [];
  for (let i = 0; i < opts.inputs; i++) {
    const prevHash = hashFor('prev', i);
    prevTxRows.push([prevHash, now - 100, 1, false, null, 1.0, null]);
    const address = addrFor(i);
    const tokenId = tokenFor(i);
    // Value
    const value = BigInt(100 + i);
    prevUtxoRows.push([
      prevHash, 0, tokenId, address, value.toString(), 0, null, null, false,
      targetHash, // spent_by = our target tx
      null, null, false,
    ]);
    inputs.push({
      tx_id: prevHash,
      index: 0,
      spent_output: {
        value: value,
        token_data: 0,
        script: 'dqkUCEboPJo9txn548FA/NLLaMLsfsSIrA==',
        locked: false,
        decoded: { type: 'P2PKH', address, timelock: null },
      },
    });
  }
  if (prevTxRows.length) {
    await conn.query(
      `INSERT INTO \`transaction\` (tx_id, timestamp, version, voided, height, weight, first_block) VALUES ?`,
      [prevTxRows],
    );
    await conn.query(
      `INSERT INTO \`tx_output\`
        (tx_id, \`index\`, token_id, address, value, authorities, timelock, heightlock, locked,
         spent_by, tx_proposal, tx_proposal_index, voided)
       VALUES ?`,
      [prevUtxoRows],
    );
  }

  // --- Outputs of the target tx (also UTXOs, not spent)
  const outputs: EventTxOutput[] = [];
  const outputRows: any[] = [];
  const outputCount = Math.min(opts.pairs, 16); // Keep output count small; the key dimension is address-token pairs.
  for (let i = 0; i < outputCount; i++) {
    const address = addrFor(i);
    const tokenId = tokenFor(i);
    const value = BigInt(10 + i);
    outputRows.push([
      targetHash, i, tokenId, address, value.toString(), 0, null, null, false,
      null, null, null, false,
    ]);
    outputs.push({
      value,
      token_data: 0,
      script: 'dqkUCEboPJo9txn548FA/NLLaMLsfsSIrA==',
      locked: false,
      decoded: { type: 'P2PKH', address, timelock: null },
    });
  }
  if (outputRows.length) {
    await conn.query(
      `INSERT INTO \`tx_output\`
        (tx_id, \`index\`, token_id, address, value, authorities, timelock, heightlock, locked,
         spent_by, tx_proposal, tx_proposal_index, voided)
       VALUES ?`,
      [outputRows],
    );
  }

  // --- Address rows (unique addresses we touch)
  const uniqueAddrs = new Set<string>();
  for (let i = 0; i < opts.pairs; i++) uniqueAddrs.add(addrFor(i));
  const addrRows = Array.from(uniqueAddrs).map((a, idx) => [a, idx, null, 1]);
  await conn.query(
    `INSERT INTO \`address\` (address, \`index\`, wallet_id, transactions) VALUES ?`,
    [addrRows],
  );

  // --- address_tx_history (one row per (address,token) pair for the target tx)
  const histRows: any[] = [];
  const balanceRows: any[] = [];
  const tokenSet = new Set<string>();
  for (let i = 0; i < opts.pairs; i++) {
    const address = addrFor(i);
    const tokenId = tokenFor(i);
    tokenSet.add(tokenId);
    histRows.push([address, targetHash, tokenId, 10 + i, now, false]);
    // address_balance must exist (balances will be decremented on void).
    balanceRows.push([
      address, tokenId,
      (10 + i).toString(), // unlocked_balance
      '0',                 // locked_balance
      null,                // timelock_expires
      1,                   // transactions
      0, 0,                // unlocked/locked authorities
      (10 + i).toString(), // total_received
    ]);
  }
  await conn.query(
    `INSERT INTO \`address_tx_history\` (address, tx_id, token_id, balance, timestamp, voided) VALUES ?`,
    [histRows],
  );
  await conn.query(
    `INSERT INTO \`address_balance\` (address, token_id, unlocked_balance, locked_balance, timelock_expires,
      transactions, unlocked_authorities, locked_authorities, total_received) VALUES ?`,
    [balanceRows],
  );

  // --- Tokens
  const tokens = Array.from(tokenSet).filter((t) => t !== '00');
  if (tokens.length) {
    const tokenRows = tokens.map((t, idx) => [t, `TOK${idx}`, `T${idx}`, 1]);
    await conn.query(
      `INSERT INTO \`token\` (id, name, symbol, transactions) VALUES ?`,
      [tokenRows],
    );
  }

  // Tokens array passed to voidTx: unique tokens for this tx.
  const txTokens = Array.from(tokenSet);

  return { targetHash, inputs, outputs, tokens: txTokens };
}

// -------------------------------------------------------------------
// Stats helpers
// -------------------------------------------------------------------
function stats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    n: values.length,
    min: sorted[0],
    p50: pct(0.5),
    p95: pct(0.95),
    max: sorted[sorted.length - 1],
    mean,
  };
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------
async function main() {
  const opts = parseArgs();
  console.log(`[bench] label=${opts.label} inputs=${opts.inputs} pairs=${opts.pairs} runs=${opts.runs} warmup=${opts.warmup}`);

  const runs: Array<{
    totalMs: number;
    spans: Record<string, number[]>;
  }> = [];

  const conn = await getConn();
  try {
    for (let i = 0; i < opts.warmup + opts.runs; i++) {
      const isWarmup = i < opts.warmup;
      const label = isWarmup ? `warmup ${i + 1}/${opts.warmup}` : `run ${i - opts.warmup + 1}/${opts.runs}`;

      await cleanDb(conn);
      const fx = await seedScenario(conn, { inputs: opts.inputs, pairs: opts.pairs });

      // Fresh span buffer per run (only track THIS run's spans)
      collectedSpans.length = 0;

      const t0 = process.hrtime.bigint();
      await voidTx(conn, fx.targetHash, fx.inputs, fx.outputs, fx.tokens, [], 1);
      const t1 = process.hrtime.bigint();
      const totalMs = Number(t1 - t0) / 1e6;

      // Bucket spans by name
      const spansByName: Record<string, number[]> = {};
      for (const s of collectedSpans) {
        if (!spansByName[s.name]) spansByName[s.name] = [];
        spansByName[s.name].push(s.durationMs);
      }
      const spanTotals: Record<string, number> = {};
      for (const [n, arr] of Object.entries(spansByName)) {
        spanTotals[n] = arr.reduce((a, b) => a + b, 0);
      }

      console.log(`[${opts.label}] ${label}  total=${totalMs.toFixed(1)}ms`);

      if (!isWarmup) {
        runs.push({ totalMs, spans: spansByName });
      }
    }
  } finally {
    await conn.end();
  }

  // ---- Aggregate ----
  const totals = runs.map((r) => r.totalMs);
  console.log('\n=== TOTAL voidTx wall-clock ===');
  console.log(stats(totals));

  // Per-span aggregation (sum durations per run, then compute stats across runs)
  const allSpanNames = new Set<string>();
  for (const r of runs) Object.keys(r.spans).forEach((n) => allSpanNames.add(n));

  console.log('\n=== Per-span duration (ms) — summed across all span instances per run ===');
  const perSpan: Record<string, any> = {};
  for (const name of allSpanNames) {
    const sums = runs.map((r) =>
      (r.spans[name] ?? []).reduce((a, b) => a + b, 0),
    );
    perSpan[name] = stats(sums);
    console.log(`${name.padEnd(32)}`, perSpan[name]);
  }

  // ---- Write JSON ----
  const fs = await import('fs');
  const outFile = `./bench-results-${opts.label}.json`;
  fs.writeFileSync(outFile, JSON.stringify({
    opts,
    totalMs: stats(totals),
    perSpan,
    raw: runs,
  }, null, 2));
  console.log(`\nResults written to ${outFile}`);

  await sdk.shutdown();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
