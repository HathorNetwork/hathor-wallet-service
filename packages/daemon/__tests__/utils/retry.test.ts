/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { addAlert, Severity } from '@wallet-service/common';
import { retryWithBackoff, retryOnLockConflict, isLockConflict } from '../../src/utils/retry';
import logger from '../../src/logger';
import * as Config from '../../src/config';

jest.mock('../../src/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('@wallet-service/common', () => ({
  ...jest.requireActual('@wallet-service/common'),
  addAlert: jest.fn().mockResolvedValue(undefined),
}));
const mockedAddAlert = addAlert as jest.Mock;

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

describe('retryOnLockConflict', () => {
  const lockError = (errno: number) => Object.assign(new Error(`lock error ${errno}`), { errno });
  // An attempt that waits out a full innodb_lock_wait_timeout before failing.
  const slowLockWait = async () => {
    jest.setSystemTime(Date.now() + 50_000);
    throw lockError(1205);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([1213, 1205])('re-runs a transaction that lost a lock conflict (errno %i)', async (errno) => {
    const fn = jest.fn()
      .mockRejectedValueOnce(lockError(errno))
      .mockResolvedValueOnce('done');

    const result = retryOnLockConflict(fn);
    await jest.runAllTimersAsync();

    await expect(result).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up on fast conflicts at its attempt cap, with the last error', async () => {
    const fn = jest.fn().mockRejectedValue(lockError(1213));

    const result = retryOnLockConflict(fn);
    result.catch(() => {});
    await jest.runAllTimersAsync();

    await expect(result).rejects.toMatchObject({ errno: 1213 });
    expect(fn).toHaveBeenCalledTimes(10);
  });

  it('gives up on lock wait timeouts once its time budget is spent', async () => {
    // Attempts start at about 0, 50, 100 and 150 s; the 4th fails past the
    // 190 s budget, so no 5th starts.
    const fn = jest.fn(slowLockWait);

    const result = retryOnLockConflict(fn);
    result.catch(() => {});
    await jest.runAllTimersAsync();

    await expect(result).rejects.toMatchObject({ errno: 1205 });
    expect(fn).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Retry budget of 190000ms exhausted after 4 attempts'));
  });

  it('falls back to the default budget when the configured one is unusable', async () => {
    const realConfig = Config.default();
    jest.spyOn(Config, 'default').mockReturnValue({ ...realConfig, LOCK_CONFLICT_RETRY_BUDGET_MS: Number.NaN });
    const fn = jest.fn(slowLockWait);

    const result = retryOnLockConflict(fn);
    result.catch(() => {});
    await jest.runAllTimersAsync();

    await expect(result).rejects.toMatchObject({ errno: 1205 });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('reports and alerts on a long wait that it got through', async () => {
    const fn = jest.fn()
      .mockImplementationOnce(slowLockWait)
      .mockImplementationOnce(slowLockWait)
      .mockResolvedValueOnce('done');

    const result = retryOnLockConflict(fn);
    await jest.runAllTimersAsync();

    await expect(result).resolves.toBe('done');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^Lock conflict cleared after 3 attempts and \d+ms$/));
    expect(mockedAddAlert).toHaveBeenCalledTimes(1);
    const [title, , severity, metadata] = mockedAddAlert.mock.calls[0];
    expect(title).toBe('Daemon waited long on a lock conflict');
    expect(severity).toBe(Severity.MINOR);
    expect(metadata).toMatchObject({ attempts: 3 });
    expect(metadata.elapsed_ms).toBeGreaterThanOrEqual(100_000);
  });

  it('names the handler and event in the log and the alert', async () => {
    const fn = jest.fn()
      .mockImplementationOnce(slowLockWait)
      .mockImplementationOnce(slowLockWait)
      .mockResolvedValueOnce('done');

    const result = retryOnLockConflict(fn, 'handleVertexAccepted, event 42');
    await jest.runAllTimersAsync();

    await expect(result).resolves.toBe('done');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/\(handleVertexAccepted, event 42\)$/));
    const [, message, , metadata] = mockedAddAlert.mock.calls[0];
    expect(message).toContain('handleVertexAccepted, event 42');
    expect(metadata).toMatchObject({ handler: 'handleVertexAccepted, event 42' });
  });

  it('reports a short wait without alerting', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(lockError(1213))
      .mockResolvedValueOnce('done');

    const result = retryOnLockConflict(fn);
    await jest.runAllTimersAsync();

    await expect(result).resolves.toBe('done');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^Lock conflict cleared after 2 attempts/));
    expect(mockedAddAlert).not.toHaveBeenCalled();
  });

  it('stays quiet when the first attempt succeeds', async () => {
    await expect(retryOnLockConflict(jest.fn().mockResolvedValue('done'))).resolves.toBe('done');

    expect(logger.warn).not.toHaveBeenCalled();
    expect(mockedAddAlert).not.toHaveBeenCalled();
  });

  it('returns the result when the slow-wait alert fails', async () => {
    mockedAddAlert.mockRejectedValueOnce(new Error('alert queue down'));
    const fn = jest.fn()
      .mockImplementationOnce(slowLockWait)
      .mockImplementationOnce(slowLockWait)
      .mockResolvedValueOnce('done');

    const result = retryOnLockConflict(fn);
    await jest.runAllTimersAsync();

    await expect(result).resolves.toBe('done');
  });

  it('does not retry any other error', async () => {
    const fn = jest.fn().mockRejectedValue(Object.assign(new Error('out of range'), { errno: 1690 }));

    await expect(retryOnLockConflict(fn)).rejects.toMatchObject({ errno: 1690 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('LOCK_CONFLICT_RETRY_BUDGET_MS', () => {
  const setEnv = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };
  const loadBudget = (value: string | undefined, idleTimeoutMs?: string): number => {
    const previous = process.env.LOCK_CONFLICT_RETRY_BUDGET_MS;
    const previousIdle = process.env.IDLE_EVENT_TIMEOUT_MS;
    setEnv('LOCK_CONFLICT_RETRY_BUDGET_MS', value);
    setEnv('IDLE_EVENT_TIMEOUT_MS', idleTimeoutMs);
    try {
      let budget = 0;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        budget = require('../../src/config').LOCK_CONFLICT_RETRY_BUDGET_MS;
      });
      return budget;
    } finally {
      setEnv('LOCK_CONFLICT_RETRY_BUDGET_MS', previous);
      setEnv('IDLE_EVENT_TIMEOUT_MS', previousIdle);
    }
  };

  it('reads a valid value from the environment', () => {
    expect(loadBudget('120000')).toBe(120000);
  });

  it.each([undefined, '', 'abc', '0', '-5', '190s', '1e5'])('falls back to the default for %p', (value) => {
    expect(loadBudget(value)).toBe(190000);
  });

  it('caps the budget a minute below the idle timeout', () => {
    expect(loadBudget('500000')).toBe(240000);
    expect(loadBudget(undefined, '120000')).toBe(60000);
  });
});

describe('isLockConflict', () => {
  it('recognises deadlocks and lock wait timeouts only', () => {
    expect(isLockConflict({ errno: 1213 })).toBe(true);
    expect(isLockConflict({ errno: 1205 })).toBe(true);
    expect(isLockConflict({ errno: 1062 })).toBe(false);
    expect(isLockConflict(new Error('no errno'))).toBe(false);
    expect(isLockConflict(null)).toBe(false);
  });
});
