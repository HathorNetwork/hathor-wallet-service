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
import { addAlert } from '@wallet-service/common';

jest.useFakeTimers();
jest.spyOn(global, 'setInterval');
jest.spyOn(global, 'clearInterval');

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

  const sendEvent = (monitoringEventType: string) => {
    receiveCallback({
      type: EventTypes.MONITORING_EVENT,
      event: { type: monitoringEventType },
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    config = getConfig();
    config['IDLE_EVENT_TIMEOUT_MS'] = 5 * 60 * 1000;      // 5 min
    config['RECONNECTION_STORM_THRESHOLD'] = 3;             // low threshold for tests
    config['RECONNECTION_STORM_WINDOW_MS'] = 5 * 60 * 1000; // 5 min

    mockCallback = jest.fn();
    mockReceive = jest.fn().mockImplementation((cb: any) => {
      receiveCallback = cb;
    });
  });

  afterAll(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

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
    expect(setInterval).toHaveBeenCalledTimes(1);

    sendEvent('DISCONNECTED');
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it('should stop the idle timer when the actor is stopped', () => {
    const stopActor = MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');
    expect(setInterval).toHaveBeenCalledTimes(1);

    stopActor();
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it('should fire an idle alert after IDLE_EVENT_TIMEOUT_MS with no events', async () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');

    // Advance time past the idle timeout
    jest.advanceTimersByTime(config['IDLE_EVENT_TIMEOUT_MS'] + 1);

    // Allow the async addAlert promise to resolve
    await Promise.resolve();

    expect(mockAddAlert).toHaveBeenCalledTimes(1);
    expect(mockAddAlert.mock.calls[0][0]).toBe('Daemon Idle — No Events Received');
  });

  it('should NOT fire an idle alert when events are being received', async () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');

    // Advance to just before the timeout
    jest.advanceTimersByTime(config['IDLE_EVENT_TIMEOUT_MS'] - 1000);
    sendEvent('EVENT_RECEIVED');

    // Advance past the original threshold (but lastEventReceivedAt was reset)
    jest.advanceTimersByTime(config['IDLE_EVENT_TIMEOUT_MS'] - 1000);

    await Promise.resolve();
    expect(mockAddAlert).not.toHaveBeenCalled();
  });

  it('should fire only one idle alert even if the timer fires multiple times', async () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');

    // Fire timer three times without receiving any events
    jest.advanceTimersByTime(config['IDLE_EVENT_TIMEOUT_MS'] * 3);

    await Promise.resolve();

    expect(mockAddAlert).toHaveBeenCalledTimes(1);
  });

  it('should reset the idle alert flag when an event is received after an alert fired', async () => {
    MonitoringActor(mockCallback, mockReceive, config);
    sendEvent('CONNECTED');

    // Trigger first alert (interval fires at T = IDLE_EVENT_TIMEOUT_MS)
    jest.advanceTimersByTime(config['IDLE_EVENT_TIMEOUT_MS'] + 1);
    await Promise.resolve();
    expect(mockAddAlert).toHaveBeenCalledTimes(1);

    // Receive an event — resets idleAlertFired and lastEventReceivedAt to current time T1
    sendEvent('EVENT_RECEIVED');

    // The next interval tick where idleMs >= threshold is at 3*T (the interval at 2*T
    // fires only T-1 ms after EVENT_RECEIVED, which is below the threshold).
    // Advancing by 2*T from T1 guarantees we cross that boundary.
    jest.advanceTimersByTime(2 * config['IDLE_EVENT_TIMEOUT_MS']);
    await Promise.resolve();

    // A second alert should now be fired
    expect(mockAddAlert).toHaveBeenCalledTimes(2);
  });

  it('should fire a reconnection storm alert when threshold is reached', async () => {
    MonitoringActor(mockCallback, mockReceive, config);

    // Send enough reconnections to trigger the storm threshold (3 in our test config)
    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING');

    await Promise.resolve();

    expect(mockAddAlert).toHaveBeenCalledTimes(1);
    expect(mockAddAlert.mock.calls[0][0]).toBe('Daemon Reconnection Storm');
  });

  it('should NOT fire a reconnection storm alert below the threshold', async () => {
    MonitoringActor(mockCallback, mockReceive, config);

    // Send fewer reconnections than the threshold
    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING');

    await Promise.resolve();
    expect(mockAddAlert).not.toHaveBeenCalled();
  });

  it('should evict old reconnections outside the storm window', async () => {
    MonitoringActor(mockCallback, mockReceive, config);

    // Two reconnections at time 0
    sendEvent('RECONNECTING');
    sendEvent('RECONNECTING');

    // Advance past the storm window so those timestamps are evicted
    jest.advanceTimersByTime(config['RECONNECTION_STORM_WINDOW_MS'] + 1000);

    // One new reconnection — count should restart from 1, no alert
    sendEvent('RECONNECTING');

    await Promise.resolve();
    expect(mockAddAlert).not.toHaveBeenCalled();
  });

  it('should restart idle timer when CONNECTED is sent while already connected', () => {
    MonitoringActor(mockCallback, mockReceive, config);

    sendEvent('CONNECTED');
    expect(setInterval).toHaveBeenCalledTimes(1);

    // A second CONNECTED clears the old timer and creates a new one
    sendEvent('CONNECTED');
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(setInterval).toHaveBeenCalledTimes(2);
  });

  it('should ignore events of other types', () => {
    const warnSpy = jest.spyOn(logger, 'warn');
    MonitoringActor(mockCallback, mockReceive, config);

    receiveCallback({ type: 'SOME_OTHER_EVENT', event: { type: 'WHATEVER' } });

    expect(warnSpy).toHaveBeenCalledWith(
      '[monitoring] Unexpected event type received by MonitoringActor',
    );
    expect(setInterval).not.toHaveBeenCalled();
  });
});
