/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Database as DatabaseType } from 'better-sqlite3';
import { bigIntUtils } from '@hathor/wallet-lib';
import WebSocket from 'ws';
import {
  initDatabase,
  insertEvents,
  insertTxEvents,
  updateBatchProgress,
  getAllBatchProgress,
  BatchProgress,
  Event as DbEvent,
  TxEvent,
} from './db';
import { createWorker, BatchConfig } from './worker';
import { extractTxHash } from './event-parser';
import { FullNodeEvent } from './types';
import { FULLNODE_HOST, USE_SSL, BATCH_SIZE, PARALLEL_CONNECTIONS, DB_PATH } from './config';

export interface DownloadStats {
  totalEvents: number;
  totalBatches: number;
  completedBatches: number;
  inProgressBatches: number;
  pendingBatches: number;
  eventsDownloaded: number;
}

export interface WorkerStatus {
  batchStart: number;
  batchEnd: number;
  eventsDownloaded: number;
  lastEventId: number;
}

export interface OrchestratorCallbacks {
  onStatsUpdate: (stats: DownloadStats) => void;
  onWorkerUpdate: (workerId: number, status: WorkerStatus) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
}

interface BatchInfo {
  start: number;
  end: number;
  lastDownloaded?: number;
}

/**
 * Get the latest event ID from the fullnode via WebSocket.
 */
export async function getLatestEventId(): Promise<number> {
  return new Promise((resolve, reject) => {
    const protocol = USE_SSL ? 'wss://' : 'ws://';
    const url = new URL(`${protocol}${FULLNODE_HOST}`);
    url.pathname = '/v1a/event_ws';

    const socket = new WebSocket(url.toString());
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Timeout waiting for initial event'));
    }, 30000);

    socket.onopen = () => {
      const startMessage = {
        type: 'START_STREAM',
        window_size: 1,
      };
      socket.send(bigIntUtils.JSONBigInt.stringify(startMessage));
    };

    socket.onmessage = (event) => {
      clearTimeout(timeout);
      try {
        const data = bigIntUtils.JSONBigInt.parse(event.data.toString());
        const latestEventId = data.latest_event_id;
        socket.close();
        resolve(latestEventId);
      } catch (error) {
        socket.close();
        reject(error);
      }
    };

    socket.onerror = (error) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${error.message}`));
    };
  });
}

/**
 * Calculate batches needed to download all events.
 */
function calculateBatches(latestEventId: number, batchSize: number): BatchInfo[] {
  const batches: BatchInfo[] = [];
  let start = 0;

  while (start < latestEventId) {
    const end = Math.min(start + batchSize - 1, latestEventId);
    batches.push({ start, end });
    start = end + 1;
  }

  return batches;
}

/**
 * Merge calculated batches with existing progress from database.
 * Handles the case where a batch was completed with a smaller boundary
 * (e.g., latestEventId was lower during a previous run).
 */
function mergeBatchesWithProgress(
  batches: BatchInfo[],
  existingProgress: BatchProgress[]
): BatchInfo[] {
  const progressMap = new Map<number, BatchProgress>();
  for (const progress of existingProgress) {
    progressMap.set(progress.batch_start, progress);
  }

  return batches.map((batch) => {
    const existing = progressMap.get(batch.start);
    if (!existing) {
      return batch;
    }

    // Only consider fully complete if the stored batch_end covers the calculated batch_end
    if (existing.status === 'completed' && existing.batch_end >= batch.end) {
      return { ...batch, lastDownloaded: batch.end };
    }

    // Batch was "completed" but with a smaller boundary - resume from where it ended
    if (existing.status === 'completed') {
      return { ...batch, lastDownloaded: existing.batch_end };
    }

    // For in-progress or failed batches, resume from last_downloaded
    if (existing.last_downloaded !== null) {
      return { ...batch, lastDownloaded: existing.last_downloaded };
    }

    return batch;
  }).filter((batch) => {
    // Filter out completed batches
    return batch.lastDownloaded === undefined || batch.lastDownloaded < batch.end;
  });
}

/**
 * Run a single worker for a batch.
 */
function runWorker(
  db: DatabaseType,
  batch: BatchInfo,
  workerId: number,
  callbacks: OrchestratorCallbacks
): Promise<void> {
  return new Promise((resolve, reject) => {
    const eventBuffer: DbEvent[] = [];
    const txEventBuffer: TxEvent[] = [];
    let eventsDownloaded = 0;
    let lastEventId = batch.lastDownloaded ?? batch.start - 1;

    const flushBuffers = () => {
      if (eventBuffer.length > 0) {
        insertEvents(db, eventBuffer);
        eventBuffer.length = 0;
      }
      if (txEventBuffer.length > 0) {
        insertTxEvents(db, txEventBuffer);
        txEventBuffer.length = 0;
      }
    };

    const config: BatchConfig = {
      batchStart: batch.start,
      batchEnd: batch.end,
      lastDownloaded: batch.lastDownloaded,
    };

    const worker = createWorker(config, {
      onEvent: (event: FullNodeEvent) => {
        eventsDownloaded++;
        lastEventId = event.event.id;

        // Buffer event for batch insert
        eventBuffer.push({
          id: event.event.id,
          type: event.event.type,
          timestamp: event.event.timestamp,
          data: bigIntUtils.JSONBigInt.stringify(event),
        });

        // Extract and buffer tx hash mapping
        const txHash = extractTxHash(event);
        if (txHash) {
          txEventBuffer.push({
            tx_hash: txHash,
            event_id: event.event.id,
            event_type: event.event.type,
          });
        }

        // Flush every 10 events to avoid memory buildup
        if (eventBuffer.length >= 10) {
          try {
            flushBuffers();
            updateBatchProgress(db, batch.start, batch.end, lastEventId, 'in_progress');
          } catch (e) {
            // Database might be closed, ignore
          }
        }
      },

      onProgress: (eventId: number) => {
        callbacks.onWorkerUpdate(workerId, {
          batchStart: batch.start,
          batchEnd: batch.end,
          eventsDownloaded,
          lastEventId: eventId,
        });
      },

      onComplete: () => {
        flushBuffers();
        updateBatchProgress(db, batch.start, batch.end, batch.end, 'completed');
        resolve();
      },

      onError: (error: Error) => {
        // Save progress before failing (only if db is still open)
        try {
          flushBuffers();
          if (lastEventId >= batch.start) {
            updateBatchProgress(db, batch.start, batch.end, lastEventId, 'failed');
          }
        } catch (e) {
          // Database might be closed already, ignore
        }
        reject(error);
      },
    });

    // Mark batch as in progress
    updateBatchProgress(db, batch.start, batch.end, batch.lastDownloaded ?? null, 'in_progress');
    worker.start();
  });
}

/**
 * Run workers with concurrency limit.
 * Each worker slot picks up the next available batch when done.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, workerSlot: number) => Promise<void>
): Promise<void> {
  const results: Promise<void>[] = [];
  let currentIndex = 0;

  const runWorkerSlot = async (workerSlot: number): Promise<void> => {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      if (index >= items.length) {
        break;
      }

      try {
        await fn(items[index], workerSlot);
      } catch (error) {
        // Log but continue with other batches
        console.error(`Worker ${workerSlot} failed:`, error);
      }
    }
  };

  // Start worker slots
  const numWorkers = Math.min(concurrency, items.length);
  for (let i = 0; i < numWorkers; i++) {
    results.push(runWorkerSlot(i));
  }

  await Promise.all(results);
}

/**
 * Main orchestrator function to download all events.
 */
export async function downloadAllEvents(callbacks: OrchestratorCallbacks): Promise<void> {
  // Initialize database
  const db = initDatabase(DB_PATH);

  try {
    // Get latest event ID from fullnode
    console.log('Connecting to fullnode to get latest event ID...');
    const latestEventId = await getLatestEventId();
    console.log(`Latest event ID: ${latestEventId.toLocaleString()}`);

    // Calculate all batches
    const allBatches = calculateBatches(latestEventId, BATCH_SIZE);
    console.log(`Total batches: ${allBatches.length} (${BATCH_SIZE.toLocaleString()} events each)`);

    // Get existing progress and merge
    const existingProgress = getAllBatchProgress(db);
    const pendingBatches = mergeBatchesWithProgress(allBatches, existingProgress);

    const completedCount = allBatches.length - pendingBatches.length;
    console.log(`Completed: ${completedCount} | Pending: ${pendingBatches.length}`);

    if (pendingBatches.length === 0) {
      console.log('All batches already completed!');
      callbacks.onComplete();
      return;
    }

    // Initialize progress tracking
    let totalEventsDownloaded = 0;
    const workerStatuses = new Map<number, WorkerStatus>();

    const updateStats = () => {
      callbacks.onStatsUpdate({
        totalEvents: latestEventId,
        totalBatches: allBatches.length,
        completedBatches: completedCount + (allBatches.length - pendingBatches.length),
        inProgressBatches: workerStatuses.size,
        pendingBatches: pendingBatches.length - workerStatuses.size,
        eventsDownloaded: totalEventsDownloaded,
      });
    };

    // Run workers with concurrency limit
    await runWithConcurrency(pendingBatches, PARALLEL_CONNECTIONS, async (batch, workerSlot) => {
      await runWorker(db, batch, workerSlot, {
        ...callbacks,
        onWorkerUpdate: (workerId, status) => {
          workerStatuses.set(workerId, status);
          totalEventsDownloaded = Array.from(workerStatuses.values())
            .reduce((sum, s) => sum + s.eventsDownloaded, 0);
          updateStats();
          callbacks.onWorkerUpdate(workerId, status);
        },
      });
      // Don't delete - worker slot will be reused for next batch
    });

    callbacks.onComplete();
  } finally {
    db.close();
  }
}
