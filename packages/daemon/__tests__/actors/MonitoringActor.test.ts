/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import MonitoringActor from '../../src/actors/MonitoringActor';
import logger from '../../src/logger';
import { EventTypes } from '../../src/types/event';
import getConfig from '../../src/config';
import { addAlert, Severity } from '@wallet-service/common';
import * as db from '../../src/db';

const MONITORING_IDLE_TIMEOUT_EVENT = { type: EventTypes.MONITORING_IDLE_TIMEOUT };

jest.useFakeTimers();
jest.spyOn(global, 'setInterval');
jest.spyOn(global, 'clearInterval');
jest.spyOn(global, 'setTimeout');
jest.spyOn(global, 'clearTimeout');

jest.mock('@wallet-service/common', () => ({
  ...jest.requireActual('@wallet-service/common'),
  addAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/db', () => ({
  getDbConnection: jest.fn(),
}));

const mockAddAlert = addAlert as jest.Mock;

describe('MonitoringActor', () => {
  let mockCallback: jest.Mock;
  let mockReceive: jest.Mock;
  let receiveCallback: (event: any) => void;
  let config: ReturnType<typeof getConfig>;
  let processExitSpy: jest.SpyInstance;

  const sendEvent = (monitoringEventType: string) => {
    receiveCallback({
      type: EventTypes.MONITORING_EVENT,
      event: { type: monitoringEventType },
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    config = getConfig();
    config['IDLE_EVENT_TIMEOUT_MS'] = 5 * 60 * 1000;       // 5 min
    config['STUCK_PROCESSING_TIMEOUT_MS'] = 5 * 60 * 1000; // 5 min
    config['RECONNECTION_STORM_THRESHOLD'] = 3;              // low threshold for tests
    config['RECONNECTION_STORM_WINDOW_MS'] = 5 * 60 * 1000; // 5 min
    config['BALANCE_VALIDATION_ENABLED'] = false;
    config['BALANCE_VALIDATION_INTERVAL_MS'] = 5000;
    config['BALANCE_VALIDATION_WINDOW_MS'] = 900000;
    config['BALANCE_VALIDATION_SAMPLE_LIMIT'] = 100;

    mockCallback = jest.fn();
    mockReceive = jest.fn().mockImplementation((cb: any) => {
      receiveCallback = cb;
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  afterAll(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  // ── Idle detection ───────────────────────────────────────────────────────────

  it('should not start the idle timer on initialization', () => {
    MonitoringActor(mockCallback, mockReceive, config);
    expect(setInterval).not.toHaveBeenCalled();
  });

  it('should start the idle timer when receiving a CONNECTED event', () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');
    expect(setInterval).toHaveBeenCalledTimes(1);
  });

  it('should stop the idle timer when receiving a DISCONNECTED event', () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');
    sendEvent('DISCONNECTED');
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it('should stop the idle timer when the actor is stopped', () => {
    const stopActor = MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');
    stopActor();
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it('should fire an idle alert and send MONITORING_IDLE_TIMEOUT after IDLE_EVENT_TIMEOUT_MS with no events', async () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');

    jest.advanceTimersByTime(config['IDLE_EVENT_TIMEOUT_MS'] + 1);
    await Promise.resolve();
    await Promise.resolve(); // flush the .finally() microtask

    expect(mockAddAlert).toHaveBeenCalledTimes(1);
    expect(mockAddAlert.mock.calls[0][0]).toBe('Daemon Idle — No Events Received');
    expect(mockAddAlert.mock.calls[0][2]).toBe(Severity.MAJOR);
    expect(mockCallback).toHaveBeenCalledWith(MONITORING_IDLE_TIMEOUT_EVENT);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should NOT fire an idle alert when events keep arriving', async () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');

    // Stay below the threshold each time
    jest.advanceTimersByTime(config['IDLE_EVENT_TIMEOUT_MS'] - 1000);
    sendEvent('EVENT_RECEIVED');
    jest.advanceTimersByTime(config['IDLE_EVENT_TIMEOUT_MS'] - 1000);

    await Promise.resolve();
    expect(mockAddAlert).not.toHaveBeenCalled();
  });

  it('should fire only one idle alert and send MONITORING_IDLE_TIMEOUT once per idle period', async () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');

    jest.advanceTimersByTime(config['IDLE_EVENT_TIMEOUT_MS'] * 3);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockAddAlert).toHaveBeenCalledTimes(1);
    expect(mockCallback).toHaveBeenCalledTimes(1);
    expect(mockCallback).toHaveBeenCalledWith(MONITORING_IDLE_TIMEOUT_EVENT);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should reset the idle alert flag when an event is received, allowing a second MONITORING_IDLE_TIMEOUT', async () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');

    // Trigger first alert (interval = T/2, fires at T/2 then T — alert at T)
    jest.advanceTimersByTime(config['IDLE_EVENT_TIMEOUT_MS'] + 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockAddAlert).toHaveBeenCalledTimes(1);
    expect(mockCallback).toHaveBeenCalledTimes(1);

    // Receive an event — resets idleAlertFired and lastEventReceivedAt (~T from start)
    sendEvent('EVENT_RECEIVED');

    // With interval=T/2, interval fires at 3T/2, 2T, 5T/2, … from start.
    // The first fire where idleMs >= T after EVENT_RECEIVED is at 5T/2 (idleMs = 3T/2 - ε).
    // Advancing 2T from here (total ~3T from start) covers 5T/2, so the second alert fires.
    jest.advanceTimersByTime(2 * config['IDLE_EVENT_TIMEOUT_MS']);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockAddAlert).toHaveBeenCalledTimes(2);
    expect(mockCallback).toHaveBeenCalledTimes(2);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should restart the idle timer when CONNECTED is sent while already running', () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');
    sendEvent('CONNECTED'); // second connect clears old and starts new
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(setInterval).toHaveBeenCalledTimes(2);
  });

  // ── Stuck-processing detection ───────────────────────────────────────────────

  it('should start a stuck timer on PROCESSING_STARTED', () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('PROCESSING_STARTED');
    expect(setTimeout).toHaveBeenCalledTimes(1);
  });

  it('should cancel the stuck timer on PROCESSING_COMPLETED', () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('PROCESSING_STARTED');
    sendEvent('PROCESSING_COMPLETED');
    expect(clearTimeout).toHaveBeenCalledTimes(1);
  });

  it('should fire a MAJOR alert when stuck and NOT send MONITORING_IDLE_TIMEOUT', async () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('PROCESSING_STARTED');

    jest.advanceTimersByTime(config['STUCK_PROCESSING_TIMEOUT_MS'] + 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockAddAlert).toHaveBeenCalledTimes(1);
    expect(mockAddAlert.mock.calls[0][0]).toBe('Daemon Stuck In Processing State');
    expect(mockAddAlert.mock.calls[0][2]).toBe(Severity.MAJOR);
    // Stuck detection intentionally does not notify the machine — machine keeps running
    expect(mockCallback).not.toHaveBeenCalled();
  });

  it('should NOT fire the stuck alert when PROCESSING_COMPLETED arrives in time', async () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('PROCESSING_STARTED');

    jest.advanceTimersByTime(config['STUCK_PROCESSING_TIMEOUT_MS'] - 1000);
    sendEvent('PROCESSING_COMPLETED');

    jest.advanceTimersByTime(2000); // advance past original timeout
    await Promise.resolve();

    expect(mockAddAlert).not.toHaveBeenCalled();
    expect(mockCallback).not.toHaveBeenCalled();
  });

  it('should reset the stuck timer on consecutive PROCESSING_STARTED events', () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('PROCESSING_STARTED');
    sendEvent('PROCESSING_STARTED'); // second one clears the first
    expect(clearTimeout).toHaveBeenCalledTimes(1);
    expect(setTimeout).toHaveBeenCalledTimes(2);
  });

  it('should stop the stuck timer when the actor is stopped', () => {
    const stopActor = MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('PROCESSING_STARTED');
    stopActor();
    expect(clearTimeout).toHaveBeenCalledTimes(1);
  });

  it('should also clear the stuck timer on DISCONNECTED', () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');
    sendEvent('PROCESSING_STARTED');
    sendEvent('DISCONNECTED');
    // clearTimeout for stuck timer + clearInterval for idle timer
    expect(clearTimeout).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  // ── Reconnection storm detection ─────────────────────────────────────────────

  it('should fire a reconnection storm alert when the threshold is reached', async () => {
    MonitoringActor(mockCallback, mockReceive, config);

    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING'); // threshold is 3 in test config

    await Promise.resolve();
    expect(mockAddAlert).toHaveBeenCalledTimes(1);
    expect(mockAddAlert.mock.calls[0][0]).toBe('Daemon Reconnection Storm');
    expect(mockAddAlert.mock.calls[0][2]).toBe(Severity.MAJOR);
  });

  it('should NOT fire a reconnection storm alert below the threshold', async () => {
    MonitoringActor(mockCallback, mockReceive, config);

    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING');

    await Promise.resolve();
    expect(mockAddAlert).not.toHaveBeenCalled();
  });

  it('should not fire more than one storm alert within the 1-minute cooldown window', async () => {
    MonitoringActor(mockCallback, mockReceive, config);

    // Trigger threshold
    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING'); // threshold = 3 → first alert

    await Promise.resolve();
    expect(mockAddAlert).toHaveBeenCalledTimes(1);

    // Additional reconnections within cooldown (no time advanced)
    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING');

    await Promise.resolve();
    // Cooldown prevents a second alert
    expect(mockAddAlert).toHaveBeenCalledTimes(1);
  });

  it('should fire another storm alert after the 1-minute cooldown expires', async () => {
    MonitoringActor(mockCallback, mockReceive, config);

    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING'); // first alert

    await Promise.resolve();
    expect(mockAddAlert).toHaveBeenCalledTimes(1);

    // Advance past the 1-minute cooldown
    jest.advanceTimersByTime(61 * 1000);

    sendEvent('RECONNECTING'); // still >= threshold in window, cooldown expired

    await Promise.resolve();
    expect(mockAddAlert).toHaveBeenCalledTimes(2);
    expect(mockAddAlert.mock.calls[1][0]).toBe('Daemon Reconnection Storm');
  });

  it('should evict old reconnections outside the storm window', async () => {
    MonitoringActor(mockCallback, mockReceive, config);

    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING');

    jest.advanceTimersByTime(config['RECONNECTION_STORM_WINDOW_MS'] + 1000);

    // Only 1 new reconnection — below threshold after eviction
    sendEvent('RECONNECTING');

    await Promise.resolve();
    expect(mockAddAlert).not.toHaveBeenCalled();
  });

  // ── Misc ─────────────────────────────────────────────────────────────────────

  it('should ignore events of other types and log a warning', () => {
    const warnSpy = jest.spyOn(logger, 'warn');
    MonitoringActor(mockCallback, mockReceive, config);

    receiveCallback({ type: 'SOME_OTHER_EVENT', event: { type: 'WHATEVER' } });

    expect(warnSpy).toHaveBeenCalledWith(
      '[monitoring] Unexpected event type received by MonitoringActor',
    );
    expect(setInterval).not.toHaveBeenCalled();
  });

  // ── Balance validation ────────────────────────────────────────────────────

  const flushPromises = () => new Promise(jest.requireActual('timers').setImmediate);

  describe('balance validation', () => {
    let mockMysql: any;

    beforeEach(() => {
      mockMysql = {
        release: jest.fn(),
        query: jest.fn().mockResolvedValue([[], []]),
      };
      (db.getDbConnection as jest.Mock).mockResolvedValue(mockMysql);
    });

    it('should not start balance validation when disabled', () => {
      config['BALANCE_VALIDATION_ENABLED'] = false;
      MonitoringActor(mockCallback, mockReceive, config);
      sendEvent('CONNECTED');

      // Only the idle-check interval should fire; no validation interval.
      expect(setInterval).toHaveBeenCalledTimes(1);
    });

    it('should start the validation interval on CONNECTED when enabled', () => {
      config['BALANCE_VALIDATION_ENABLED'] = true;
      MonitoringActor(mockCallback, mockReceive, config);
      sendEvent('CONNECTED');

      // Idle check + balance validation = 2 intervals.
      expect(setInterval).toHaveBeenCalledTimes(2);
      expect(setInterval).toHaveBeenCalledWith(
        expect.any(Function),
        config['BALANCE_VALIDATION_INTERVAL_MS'],
      );
    });

    it('should clear the validation interval on DISCONNECTED', () => {
      config['BALANCE_VALIDATION_ENABLED'] = true;
      MonitoringActor(mockCallback, mockReceive, config);
      sendEvent('CONNECTED');
      sendEvent('DISCONNECTED');

      // Idle check + balance validation = 2 cleared intervals.
      expect(clearInterval).toHaveBeenCalledTimes(2);
    });

    it('should alert when the validation query returns mismatch rows', async () => {
      config['BALANCE_VALIDATION_ENABLED'] = true;

      const mismatchRow = {
        address: 'addr1',
        tokenId: 'token1',
        balanceSum: '100',
        historySum: '200',
      };
      mockMysql.query.mockResolvedValueOnce([[mismatchRow], []]);

      MonitoringActor(mockCallback, mockReceive, config);
      sendEvent('CONNECTED');

      jest.advanceTimersByTime(config['BALANCE_VALIDATION_INTERVAL_MS']);
      await flushPromises();

      expect(mockMysql.query).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN'));
      // Scope-by-updated_at is load-bearing for perf (see follow-up #404);
      // pin it so a future refactor doesn't silently drop the filter.
      expect(mockMysql.query).toHaveBeenCalledWith(expect.stringContaining('ab.updated_at > NOW() - INTERVAL'));
      expect(mockAddAlert).toHaveBeenCalledWith(
        'Balance validation found mismatches',
        expect.stringContaining('1 balance mismatch'),
        Severity.MAJOR,
        expect.objectContaining({
          truncated: false,
          samples: [mismatchRow],
        }),
        expect.anything(),
      );
      expect(mockMysql.release).toHaveBeenCalled();
    });

    it('should log info when no mismatches found', async () => {
      config['BALANCE_VALIDATION_ENABLED'] = true;
      const mockLoggerInfo = jest.spyOn(logger, 'info');

      mockMysql.query.mockResolvedValueOnce([[], []]);

      MonitoringActor(mockCallback, mockReceive, config);
      sendEvent('CONNECTED');

      jest.advanceTimersByTime(config['BALANCE_VALIDATION_INTERVAL_MS']);
      await flushPromises();

      expect(mockAddAlert).not.toHaveBeenCalled();
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining('no mismatches found'),
      );
    });

    it('should mark the alert as truncated when the row count hits the LIMIT', async () => {
      config['BALANCE_VALIDATION_ENABLED'] = true;

      // The actor's SAMPLE_LIMIT is 100; if exactly that many come back we
      // assume more exist and surface "100+" + truncated:true.
      const rows = Array.from({ length: 100 }, (_, i) => ({
        address: `addr${i}`, tokenId: 'tok', balanceSum: '1', historySum: '0',
      }));
      mockMysql.query.mockResolvedValueOnce([rows, []]);

      MonitoringActor(mockCallback, mockReceive, config);
      sendEvent('CONNECTED');

      jest.advanceTimersByTime(config['BALANCE_VALIDATION_INTERVAL_MS']);
      await flushPromises();

      expect(mockAddAlert).toHaveBeenCalledWith(
        'Balance validation found mismatches',
        expect.stringContaining('100+'),
        Severity.MAJOR,
        expect.objectContaining({ truncated: true }),
        expect.anything(),
      );
    });

    it('should handle DB errors without crashing', async () => {
      config['BALANCE_VALIDATION_ENABLED'] = true;
      const mockLoggerError = jest.spyOn(logger, 'error');

      (db.getDbConnection as jest.Mock).mockRejectedValueOnce(new Error('DB connection failed'));

      MonitoringActor(mockCallback, mockReceive, config);
      sendEvent('CONNECTED');

      jest.advanceTimersByTime(config['BALANCE_VALIDATION_INTERVAL_MS']);
      await flushPromises();

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('Balance validation error'),
      );
    });

    it('should refuse to schedule validation when interval is NaN', () => {
      config['BALANCE_VALIDATION_ENABLED'] = true;
      config['BALANCE_VALIDATION_INTERVAL_MS'] = NaN;
      const mockLoggerError = jest.spyOn(logger, 'error');

      MonitoringActor(mockCallback, mockReceive, config);
      sendEvent('CONNECTED');

      // Only the idle-check interval should fire; the validation interval
      // must NOT be scheduled because the config is invalid.
      expect(setInterval).toHaveBeenCalledTimes(1);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('BALANCE_VALIDATION_INTERVAL_MS=NaN is invalid'),
      );
    });

    it('should refuse to schedule validation when interval is below the minimum', () => {
      config['BALANCE_VALIDATION_ENABLED'] = true;
      config['BALANCE_VALIDATION_INTERVAL_MS'] = 10; // below the 1000ms floor
      const mockLoggerError = jest.spyOn(logger, 'error');

      MonitoringActor(mockCallback, mockReceive, config);
      sendEvent('CONNECTED');

      expect(setInterval).toHaveBeenCalledTimes(1);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('is invalid'),
      );
    });

    it('should refuse to schedule validation when sample limit is invalid', () => {
      config['BALANCE_VALIDATION_ENABLED'] = true;
      config['BALANCE_VALIDATION_SAMPLE_LIMIT'] = 0; // 0 would silently skip every row
      const mockLoggerError = jest.spyOn(logger, 'error');

      MonitoringActor(mockCallback, mockReceive, config);
      sendEvent('CONNECTED');

      expect(setInterval).toHaveBeenCalledTimes(1);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('BALANCE_VALIDATION_SAMPLE_LIMIT=0 is invalid'),
      );
    });
  });
});
