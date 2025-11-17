/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { retryWithBackoff } from '../../src/utils/retry';
import logger from '../../src/logger';

jest.mock('../../src/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

describe('retryWithBackoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should succeed on first attempt', async () => {
    const mockFn = jest.fn().mockResolvedValue('success');

    const promise = retryWithBackoff(mockFn);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should retry on network error and eventually succeed', async () => {
    const mockFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce('success');

    const promise = retryWithBackoff(mockFn, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    // Fast-forward through all timers
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('should retry on 5xx server errors', async () => {
    const serverError = {
      response: {
        status: 500,
      },
      message: 'Internal Server Error',
    };

    const mockFn = jest
      .fn()
      .mockRejectedValueOnce(serverError)
      .mockResolvedValueOnce('success');

    const promise = retryWithBackoff(mockFn, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should not retry on 4xx client errors', async () => {
    const clientError = {
      response: {
        status: 404,
      },
      message: 'Not Found',
    };

    const mockFn = jest.fn().mockRejectedValue(clientError);

    await expect(
      retryWithBackoff(mockFn, {
        maxRetries: 3,
        initialDelayMs: 100,
      })
    ).rejects.toEqual(clientError);

    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should throw error after exhausting all retries', async () => {
    const error = new Error('Network error');
    const mockFn = jest.fn().mockRejectedValue(error);

    const promise = retryWithBackoff(mockFn, {
      maxRetries: 2,
      initialDelayMs: 100,
    });

    // Run all timers and wait for promise to settle
    const resultPromise = promise.catch((e) => e);
    await jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual(error);
    expect(mockFn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('All 2 retry attempts exhausted');
  });

  it('should use exponential backoff', async () => {
    const mockFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Fail 1'))
      .mockRejectedValueOnce(new Error('Fail 2'))
      .mockResolvedValueOnce('success');

    const promise = retryWithBackoff(mockFn, {
      maxRetries: 3,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
    });

    // First retry should wait 1000ms
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockFn).toHaveBeenCalledTimes(2);

    // Second retry should wait 2000ms
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('should respect maxDelayMs', async () => {
    const mockFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Fail 1'))
      .mockRejectedValueOnce(new Error('Fail 2'))
      .mockRejectedValueOnce(new Error('Fail 3'))
      .mockResolvedValueOnce('success');

    const promise = retryWithBackoff(mockFn, {
      maxRetries: 4,
      initialDelayMs: 1000,
      maxDelayMs: 3000,
      backoffMultiplier: 2,
    });

    // First retry: 1000ms
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockFn).toHaveBeenCalledTimes(2);

    // Second retry: 2000ms
    await jest.advanceTimersByTimeAsync(2000);
    expect(mockFn).toHaveBeenCalledTimes(3);

    // Third retry: should be capped at 3000ms instead of 4000ms
    await jest.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(4);
  });

  it('should use custom retryableErrors function', async () => {
    const customError = new Error('Custom non-retryable error');
    const mockFn = jest.fn().mockRejectedValue(customError);

    await expect(
      retryWithBackoff(mockFn, {
        maxRetries: 3,
        retryableErrors: (error) => error.message !== 'Custom non-retryable error',
      })
    ).rejects.toThrow('Custom non-retryable error');

    expect(mockFn).toHaveBeenCalledTimes(1);
  });
});
