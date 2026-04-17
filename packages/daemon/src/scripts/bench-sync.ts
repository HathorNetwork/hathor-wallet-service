/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Sync benchmark harness.
 *
 * Runs the daemon's SyncMachine against an integration-test event simulator,
 * captures per-span timings via an in-memory OTel exporter, and writes
 * aggregated stats to JSON. Produces numbers that can be compared across
 * branches to reason about per-event sync performance.
 *
 * WARNING: The `daemon-bench` CI workflow overlays this file onto master's
 * production code to measure the baseline — so any symbol this file imports
 * or references must also exist on master. If a future PR renames a span,
 * removes an exported function, or changes a signature this script relies
 * on, update the workflow (or this script) accordingly.
 *
 * Prerequisites (run from packages/daemon):
 *   yarn test_images_up              # starts MySQL + all simulator containers
 *   yarn test_images_wait_for_db
 *   yarn test_images_migrate
 *   yarn test_images_wait_for_ws
 *
 * Usage:
 *   yarn bench:sync --scenario UNVOIDED --runs 5 --warmup 1 --label master
 *   yarn bench:sync --scenario VOIDED_TOKEN_AUTHORITY --runs 10 --out bench.json
 *
 * Scenarios mirror __tests__/integration/config.ts. Current scenarios all top
 * out at <70 events, which is too few for stable per-event timing — fullnode
 * connect / MySQL pool warmup / JIT noise dominate. Add a larger scenario
 * before drawing conclusions from absolute numbers; the harness is
 * otherwise correct.
 */

// Disable the daemon's built-in OTLP exporter — we install our own
// in-memory exporter below. Must be set before any daemon import.
process.env.OTEL_SDK_DISABLED = 'true';

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface Opts {
  scenario: string;
  runs: number;
  warmup: number;
  label: string;
  out: string;
}

function parseArgs(): Opts {
  const args = process.argv.slice(2);
  const opts: Opts = {
    scenario: 'UNVOIDED',
    runs: 5,
    warmup: 1,
    label: 'local',
    out: '',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    switch (a) {
      case '--scenario': opts.scenario = v; i++; break;
      case '--runs': opts.runs = parseInt(v, 10); i++; break;
      case '--warmup': opts.warmup = parseInt(v, 10); i++; break;
      case '--label': opts.label = v; i++; break;
      case '--out': opts.out = v; i++; break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown arg: ${a}`);
        printHelp();
        process.exit(1);
    }
  }
  if (!opts.out) opts.out = `bench-results-${opts.label}.json`;
  return opts;
}

function printHelp() {
  console.log(`Usage: bench-sync [options]

Options:
  --scenario <name>  Simulator scenario (default: UNVOIDED)
  --runs <n>         Measured runs (default: 5)
  --warmup <n>       Discarded warmup runs (default: 1)
  --label <str>      Label for the output file and opts block (default: local)
  --out <path>       Output JSON path (default: bench-results-<label>.json)

Available scenarios: ${Object.keys(SCENARIOS).join(', ')}
`);
}

// Keep in sync with __tests__/integration/config.ts
const SCENARIOS: Record<string, { port: number; lastEvent: number }> = {
  UNVOIDED: { port: 8081, lastEvent: 39 },
  REORG: { port: 8082, lastEvent: 18 },
  SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS: { port: 8083, lastEvent: 37 },
  INVALID_MEMPOOL_TRANSACTION: { port: 8085, lastEvent: 40 },
  CUSTOM_SCRIPT: { port: 8086, lastEvent: 37 },
  EMPTY_SCRIPT: { port: 8087, lastEvent: 37 },
  NC_EVENTS: { port: 8088, lastEvent: 36 },
  TRANSACTION_VOIDING_CHAIN: { port: 8089, lastEvent: 52 },
  VOIDED_TOKEN_AUTHORITY: { port: 8090, lastEvent: 66 },
  SINGLE_VOIDED_CREATE_TOKEN_TRANSACTION: { port: 8091, lastEvent: 50 },
  SINGLE_VOIDED_REGULAR_TRANSACTION: { port: 8092, lastEvent: 60 },
  TOKEN_CREATION: { port: 8093, lastEvent: 45 },
};

const opts = parseArgs();
const scenario = SCENARIOS[opts.scenario];
if (!scenario) {
  console.error(`Unknown scenario: ${opts.scenario}`);
  console.error(`Available: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Environment setup — must happen before any daemon import (config is
// env-driven at module load time).
// ---------------------------------------------------------------------------

Object.assign(process.env, {
  NETWORK: 'testnet',
  SERVICE_NAME: 'daemon-bench',
  CONSOLE_LEVEL: 'error',
  TX_CACHE_SIZE: '100',
  BLOCK_REWARD_LOCK: '300',
  FULLNODE_PEER_ID: 'simulator_peer_id',
  STREAM_ID: 'simulator_stream_id',
  FULLNODE_NETWORK: 'unittests',
  FULLNODE_HOST: `127.0.0.1:${scenario.port}`,
  USE_SSL: 'false',
  DB_ENDPOINT: '127.0.0.1',
  DB_NAME: 'hathor',
  DB_USER: 'root',
  DB_PASS: 'hathor',
  DB_PORT: '3380',
  ACK_TIMEOUT_MS: '300000',
  IDLE_EVENT_TIMEOUT_MS: String(5 * 60 * 1000),
  STUCK_PROCESSING_TIMEOUT_MS: String(5 * 60 * 1000),
  RECONNECTION_STORM_THRESHOLD: '10',
  RECONNECTION_STORM_WINDOW_MS: String(5 * 60 * 1000),
  // checkEnvVariables() requires these but they are never actually called
  // because the AWS/lambda/SQS paths are stubbed below.
  NEW_TX_SQS: 'bench-stub',
  PUSH_NOTIFICATION_ENABLED: 'false',
  WALLET_SERVICE_LAMBDA_ENDPOINT: 'bench-stub',
  STAGE: 'local',
  ACCOUNT_ID: '000000000000',
  ALERT_MANAGER_TOPIC: 'bench-stub',
  ALERT_MANAGER_REGION: 'us-east-1',
  APPLICATION_NAME: 'bench',
});

// ---------------------------------------------------------------------------
// In-memory OTel capture. Using BasicTracerProvider directly (instead of
// NodeSDK) because .register() is synchronous — the global tracer provider
// is guaranteed to be in place before any `trace.getTracer()` call from the
// daemon modules imported below resolves its first span.
// ---------------------------------------------------------------------------

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

// ---------------------------------------------------------------------------
// Stub external services that the daemon would otherwise try to reach
// (SQS, push-notification lambda, fullnode HTTP API). Mirrors the jest.mock
// calls in __tests__/integration/balances.test.ts.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as awsUtils from '../utils/aws';
import * as services from '../services';

(awsUtils as any).sendRealtimeTx = async () => undefined;
(awsUtils as any).invokeOnTxPushNotificationRequestedLambda = async () => undefined;
(services as any).checkForMissedEvents = async () => ({ hasNewEvents: false, events: [] });
(services as any).fetchMinRewardBlocks = async () => 300;
/* eslint-enable @typescript-eslint/no-explicit-any */

import { interpret } from 'xstate';
import { SyncMachine } from '../machines';
import { getDbConnection } from '../db';
import { cleanDatabase, transitionUntilEvent } from '../../__tests__/integration/utils';

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

interface RunResult {
  totalMs: number;
  /** span name → list of individual span durations observed during the run */
  spans: Map<string, number[]>;
}

async function runOnce(mysql: Awaited<ReturnType<typeof getDbConnection>>): Promise<RunResult> {
  await cleanDatabase(mysql);
  exporter.reset();

  const machine = interpret(SyncMachine);
  const start = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await transitionUntilEvent(mysql as any, machine as any, scenario.lastEvent);
  const totalMs = performance.now() - start;

  const spans = new Map<string, number[]>();
  for (const span of exporter.getFinishedSpans()) {
    const [s, ns] = span.duration;
    const ms = s * 1000 + ns / 1e6;
    const list = spans.get(span.name) ?? [];
    list.push(ms);
    spans.set(span.name, list);
  }
  return { totalMs, spans };
}

interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
  /** Raw per-run values, retained so downstream tools (e.g. bench-compare)
   *  can bootstrap confidence intervals on the median delta. */
  samples: number[];
}

function summarize(values: number[]): Summary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: values.length,
    min: sorted[0],
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1],
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    samples: values,
  };
}

async function main() {
  const mysql = await getDbConnection();

  const totalMsRuns: number[] = [];
  // Per span name: one entry per measured run, each entry is the sum of all
  // durations of that span within the run. Summing makes runs comparable even
  // when the number of span occurrences differs (e.g., voided vs un-voided
  // paths fire different spans).
  const perSpanRuns = new Map<string, number[]>();

  const total = opts.warmup + opts.runs;
  for (let i = 0; i < total; i++) {
    const phase = i < opts.warmup ? `warmup ${i + 1}/${opts.warmup}` : `run ${i - opts.warmup + 1}/${opts.runs}`;
    process.stderr.write(`[${phase}] `);
    const result = await runOnce(mysql);
    process.stderr.write(`totalMs=${result.totalMs.toFixed(2)}\n`);

    if (i < opts.warmup) continue;

    totalMsRuns.push(result.totalMs);
    for (const [name, durations] of result.spans) {
      const sum = durations.reduce((a, b) => a + b, 0);
      const arr = perSpanRuns.get(name) ?? [];
      arr.push(sum);
      perSpanRuns.set(name, arr);
    }
  }

  const output = {
    opts: {
      scenario: opts.scenario,
      port: scenario.port,
      lastEvent: scenario.lastEvent,
      runs: opts.runs,
      warmup: opts.warmup,
      label: opts.label,
    },
    totalMs: summarize(totalMsRuns),
    perSpan: Object.fromEntries(
      [...perSpanRuns.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, runs]) => [name, summarize(runs)])
    ),
  };

  writeFileSync(opts.out, JSON.stringify(output, null, 2));
  console.log(`Wrote ${opts.out}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ('release' in (mysql as any)) (mysql as any).release();
  await provider.shutdown();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
