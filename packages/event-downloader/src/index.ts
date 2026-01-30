#!/usr/bin/env node
/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { checkEnvVariables, BATCH_SIZE, PARALLEL_CONNECTIONS, WINDOW_SIZE, DB_PATH, FULLNODE_HOST } from './config';
import { downloadAllEvents, DownloadStats, WorkerStatus } from './orchestrator';

// ANSI escape codes for terminal formatting
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_SCREEN = '\x1b[2J';
const MOVE_HOME = '\x1b[H';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const workerStatuses = new Map<number, WorkerStatus>();
let lastRenderTime = 0;
const RENDER_INTERVAL_MS = 500; // Only redraw every 500ms

// For rate and ETA calculation
let startTime = 0;
let lastEventsDownloaded = 0;
let lastRateCheckTime = 0;
let currentRate = 0; // events per second

function formatNumber(num: number): string {
  return num.toLocaleString();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function formatRate(rate: number): string {
  if (rate >= 1000) {
    return `${(rate / 1000).toFixed(1)}k/s`;
  }
  return `${Math.round(rate)}/s`;
}

function progressBar(percent: number, width: number = 40): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

let lastStats: DownloadStats | null = null;

function render(): void {
  if (!lastStats) return;

  const stats = lastStats;
  const percent = stats.totalEvents > 0
    ? (stats.eventsDownloaded / stats.totalEvents) * 100
    : 0;

  // Calculate rate
  const now = Date.now();
  if (lastRateCheckTime > 0) {
    const timeDelta = (now - lastRateCheckTime) / 1000;
    if (timeDelta > 0) {
      const eventsDelta = stats.eventsDownloaded - lastEventsDownloaded;
      // Smooth the rate with exponential moving average
      const newRate = eventsDelta / timeDelta;
      currentRate = currentRate === 0 ? newRate : currentRate * 0.7 + newRate * 0.3;
    }
  }
  lastRateCheckTime = now;
  lastEventsDownloaded = stats.eventsDownloaded;

  // Calculate ETA
  const eventsRemaining = stats.totalEvents - stats.eventsDownloaded;
  const etaSeconds = currentRate > 0 ? eventsRemaining / currentRate : 0;

  // Calculate elapsed time
  const elapsedSeconds = startTime > 0 ? (now - startTime) / 1000 : 0;

  // Move cursor to home and clear screen
  process.stdout.write(MOVE_HOME + CLEAR_SCREEN);

  // Header
  console.log(`${BOLD}Event Downloader v1.0.0${RESET}`);
  console.log('━'.repeat(60));
  console.log(`${CYAN}Fullnode:${RESET} ${FULLNODE_HOST}`);
  console.log(`${CYAN}Database:${RESET} ${DB_PATH}`);
  console.log(`${CYAN}Batch Size:${RESET} ${formatNumber(BATCH_SIZE)} | ${CYAN}Workers:${RESET} ${PARALLEL_CONNECTIONS} | ${CYAN}Window:${RESET} ${WINDOW_SIZE}`);
  console.log('━'.repeat(60));
  console.log();

  // Stats
  console.log(`${CYAN}Latest event ID:${RESET} ${formatNumber(stats.totalEvents)}`);
  console.log(`${CYAN}Total batches:${RESET} ${stats.totalBatches}`);
  console.log(
    `${GREEN}Completed:${RESET} ${stats.completedBatches} | ` +
    `${YELLOW}In Progress:${RESET} ${stats.inProgressBatches} | ` +
    `Pending: ${stats.pendingBatches}`
  );
  console.log();
  console.log(`${progressBar(percent)} ${percent.toFixed(1)}%`);
  console.log(`${CYAN}Events downloaded:${RESET} ${formatNumber(stats.eventsDownloaded)}`);
  console.log(
    `${CYAN}Rate:${RESET} ${formatRate(currentRate)} | ` +
    `${CYAN}Elapsed:${RESET} ${formatDuration(elapsedSeconds)} | ` +
    `${CYAN}ETA:${RESET} ${etaSeconds > 0 ? formatDuration(etaSeconds) : '--'}`
  );
  console.log();

  // Print worker statuses
  const sortedWorkers = Array.from(workerStatuses.entries()).sort((a, b) => a[0] - b[0]);
  for (const [workerId, status] of sortedWorkers) {
    const workerPercent = ((status.lastEventId - status.batchStart) / (status.batchEnd - status.batchStart) * 100).toFixed(0);
    console.log(
      `Worker ${workerId + 1}: ${formatNumber(status.batchStart)}-${formatNumber(status.batchEnd)} | ` +
      `${formatNumber(status.eventsDownloaded)} events (${workerPercent}%)`
    );
  }
}

function printStats(stats: DownloadStats): void {
  lastStats = stats;

  const now = Date.now();
  if (now - lastRenderTime < RENDER_INTERVAL_MS) {
    return; // Throttle updates
  }
  lastRenderTime = now;

  render();
}

function handleWorkerUpdate(workerId: number, status: WorkerStatus): void {
  workerStatuses.set(workerId, status);
}

async function main(): Promise<void> {
  try {
    // Check environment variables
    checkEnvVariables();

    // Hide cursor and clear screen
    process.stdout.write(HIDE_CURSOR + CLEAR_SCREEN + MOVE_HOME);

    console.log(`${BOLD}Event Downloader v1.0.0${RESET}`);
    console.log('Connecting to fullnode...');

    // Initialize timing
    startTime = Date.now();

    // Handle graceful shutdown
    const cleanup = () => {
      process.stdout.write(SHOW_CURSOR);
      console.log('\n\nDownload interrupted. Progress has been saved.');
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Start download
    await downloadAllEvents({
      onStatsUpdate: printStats,
      onWorkerUpdate: handleWorkerUpdate,
      onComplete: () => {
        render(); // Final render
        process.stdout.write(SHOW_CURSOR);
        console.log();
        console.log('━'.repeat(60));
        console.log(`${GREEN}${BOLD}Download complete!${RESET}`);
        console.log(`Database saved to: ${DB_PATH}`);
      },
      onError: (error) => {
        process.stdout.write(SHOW_CURSOR);
        console.error(`\n${BOLD}Error:${RESET}`, error.message);
      },
    });
  } catch (error) {
    process.stdout.write(SHOW_CURSOR);
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
