/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { addAlert, Severity } from '@wallet-service/common';
import logger from '../logger';
import getConfig, { DEFAULT_LOCK_CONFLICT_RETRY_BUDGET_MS } from '../config';

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: (error: any) => boolean;
  /**
   * Stop retrying once this long has passed since the first attempt started,
   * even with retries left. Checked after each failed attempt; unset means no
   * time limit.
   */
  maxElapsedMs?: number;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'maxElapsedMs'>> = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryableErrors: (error: any) => {
    // Retry on network errors and 5xx server errors
    if (error.response) {
      // HTTP error response received
      return error.response.status >= 500 && error.response.status < 600;
    }
    // Network error (no response received)
    return true;
  },
};

/**
 * Sleep utility function
 */
const sleep = (ms: number): Promise<void> => new Promise(resolve => {
  setTimeout(resolve, ms);
});

/**
 * Calculate the delay for the next retry attempt using exponential backoff
 */
const calculateDelay = (
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number
): number => {
  const delay = initialDelayMs * (backoffMultiplier ** attempt);
  return Math.min(delay, maxDelayMs);
};

/**
 * Retry a function with exponential backoff
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration options
 * @returns Promise that resolves with the function result or rejects with the last error
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const startedAt = Date.now();
  let lastError: any;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      if (!config.retryableErrors(error)) {
        logger.debug('Error is not retryable, throwing immediately');
        throw error;
      }

      // Check if the time budget is spent
      if (config.maxElapsedMs !== undefined && Date.now() - startedAt >= config.maxElapsedMs) {
        logger.error(`Retry budget of ${config.maxElapsedMs}ms exhausted after ${attempt + 1} attempts`);
        throw error;
      }

      // Check if we've exhausted all retries
      if (attempt === config.maxRetries) {
        logger.error(`All ${config.maxRetries} retry attempts exhausted`);
        throw error;
      }

      // Calculate delay and wait before next retry
      const delay = calculateDelay(
        attempt,
        config.initialDelayMs,
        config.maxDelayMs,
        config.backoffMultiplier
      );

      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Retry attempt ${attempt + 1}/${config.maxRetries} failed. ` +
        `Retrying in ${delay}ms. Error: ${errorMsg}`
      );

      await sleep(delay);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

/**
 * Whether a database error is a lock conflict that re-running the whole
 * transaction can clear: InnoDB chose the transaction as a deadlock victim
 * (1213) or it waited longer than `innodb_lock_wait_timeout` for a lock (1205).
 */
export const isLockConflict = (error: unknown): boolean => {
  const errno = (error as { errno?: unknown } | null)?.errno;
  return errno === 1213 || errno === 1205;
};

/** Hard cap on attempts, so a storm of fast deadlocks cannot spin for the whole budget. */
const LOCK_CONFLICT_MAX_ATTEMPTS = 10;

/** A wait at least this long, once got through, raises a MINOR alert. */
const LOCK_CONFLICT_ALERT_MS = 60_000;

const lockConflictRetryBudgetMs = (): number => {
  const budget = getConfig().LOCK_CONFLICT_RETRY_BUDGET_MS;
  return Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_LOCK_CONFLICT_RETRY_BUDGET_MS;
};

/**
 * Run a handler's transaction again when it loses a lock conflict.
 *
 * The daemon shares rows with the wallet-service, whose recovery commit locks
 * a wallet's balance rows for its whole transaction. InnoDB rolls back the
 * side with fewer locks, which is usually the daemon, and no single lock order
 * rules every conflict out because the daemon's own paths take its tables in
 * different orders. Without a retry, losing one conflict ends sync: the sync
 * machine treats a failed handler as final.
 *
 * Safe for the transactional handlers because each one rolls back fully on
 * error, reads what it needs again from the start, and sends nothing outside
 * the database until after it commits (ingest queues its notifications for
 * then).
 *
 * It retries while less than `LOCK_CONFLICT_RETRY_BUDGET_MS` has passed since
 * the first attempt started, and at most `LOCK_CONFLICT_MAX_ATTEMPTS` times. A
 * lock wait timeout costs a full `innodb_lock_wait_timeout` (50 s by default)
 * per attempt, so the worst case is the budget plus one wait. Time spent in a
 * handler counts toward the monitor's idle timeout, which terminates the
 * daemon, so the budget sits below it. The budget is per handler: an event
 * whose handlers each wait can take longer.
 *
 * A wait it gets through is logged, and alerted when it lasted a minute or
 * more: the daemon stalled that long, most likely behind a wallet-service
 * settle. `label` names the handler and event in both.
 */
export const retryOnLockConflict = async <T>(fn: () => Promise<T>, label?: string): Promise<T> => {
  const startedAt = Date.now();
  let attempts = 0;
  const result = await retryWithBackoff(() => {
    attempts += 1;
    return fn();
  }, {
    maxRetries: LOCK_CONFLICT_MAX_ATTEMPTS - 1,
    initialDelayMs: 100,
    maxDelayMs: 1000,
    backoffMultiplier: 2,
    retryableErrors: isLockConflict,
    maxElapsedMs: lockConflictRetryBudgetMs(),
  });
  if (attempts > 1) {
    const elapsedMs = Date.now() - startedAt;
    const where = label ? ` (${label})` : '';
    logger.warn(`Lock conflict cleared after ${attempts} attempts and ${elapsedMs}ms${where}`);
    if (elapsedMs >= LOCK_CONFLICT_ALERT_MS) {
      // Not awaited: the handler has committed, and sync should not wait on it.
      // Any failure, even a synchronous one, only logs.
      Promise.resolve().then(() => addAlert(
        'Daemon waited long on a lock conflict',
        `A handler${where} waited ${elapsedMs} ms over ${attempts} attempts for database locks before it committed. `
        + 'Sync was stalled for that long, most likely behind a wallet-service settle.',
        Severity.MINOR,
        { elapsed_ms: elapsedMs, attempts, handler: label ?? 'unknown' },
        logger,
      )).catch((alertError) => {
        logger.error(`Failed to send the lock-wait alert: ${String(alertError)}`);
      });
    }
  }
  return result;
};
