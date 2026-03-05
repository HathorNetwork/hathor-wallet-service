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
});
