/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import logger from '../logger';

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: (error: any) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
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
 * Two retries at most: a lock wait timeout takes `innodb_lock_wait_timeout`
 * (50 s by default) per attempt, and time spent in a handler counts toward
 * the monitor's idle timeout (5 minutes), past which it stops sync anyway.
 */
export const retryOnLockConflict = <T>(fn: () => Promise<T>): Promise<T> => retryWithBackoff(fn, {
  maxRetries: 2,
  initialDelayMs: 100,
  maxDelayMs: 1000,
  backoffMultiplier: 2,
  retryableErrors: isLockConflict,
});
