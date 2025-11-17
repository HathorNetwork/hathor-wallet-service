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
  maxRetries: 3,
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
