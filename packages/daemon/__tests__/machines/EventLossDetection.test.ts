/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @jest-environment node
 */

import {
  CONNECTED_STATES,
  SyncMachine,
  SYNC_MACHINE_STATES,
} from '../../src/machines';
import { EventTypes, FullNodeEvent } from '../../src/types';
import EventFixtures from '../__fixtures__/events';

const { NEW_VERTEX_ACCEPTED } = EventFixtures;

describe('Event Loss Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should transition to checkingForMissedEvents after ACK timeout', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      delays: {
        ACK_TIMEOUT: 100,
      },
      actions: {
        startStream: () => {},
      },
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
        unchanged: () => true,
      },
    });

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `done.invoke.SyncMachine.${SYNC_MACHINE_STATES.INITIALIZING}:invocation[0]`,
      // @ts-ignore
      data: { lastEventId: 999 },
    });

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.WEBSOCKET_EVENT,
      event: { type: 'CONNECTED' },
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.idle}`)).toBeTruthy();

    // Send an event to trigger ACK
    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: NEW_VERTEX_ACCEPTED as unknown as FullNodeEvent,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.idle}`)).toBeTruthy();

    // Simulate ACK timeout
    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `xstate.after(ACK_TIMEOUT)#${CONNECTED_STATES.idle}`,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.checkingForMissedEvents}`)).toBeTruthy();
  });

  it('should reconnect websocket if HTTP API returns new events', () => {
    const checkForMissedEventsMock = jest.fn();

    const MockedFetchMachine = SyncMachine.withConfig({
      delays: {
        ACK_TIMEOUT: 100,
      },
      services: {
        checkForMissedEvents: checkForMissedEventsMock,
      },
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
        unchanged: () => true,
      },
      actions: {
        startStream: () => {},
      },
    });

    checkForMissedEventsMock.mockResolvedValue({
      hasNewEvents: true,
      events: [{ event: { id: 1000 } }],
    });

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `done.invoke.SyncMachine.${SYNC_MACHINE_STATES.INITIALIZING}:invocation[0]`,
      // @ts-ignore
      data: { lastEventId: 999 },
    });

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.WEBSOCKET_EVENT,
      event: { type: 'CONNECTED' },
    });

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: NEW_VERTEX_ACCEPTED as unknown as FullNodeEvent,
    });

    // Simulate timeout
    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `xstate.after(ACK_TIMEOUT)#${CONNECTED_STATES.idle}`,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.checkingForMissedEvents}`)).toBeTruthy();

    // Simulate service completion with new events found
    currentState = MockedFetchMachine.transition(currentState, {
      type: 'done.invoke.checkForMissedEvents' as any,
      data: {
        hasNewEvents: true,
        events: [{ event: { id: 1000 } }],
      },
    } as any);

    // Should transition to RECONNECTING state
    expect(currentState.matches(SYNC_MACHINE_STATES.RECONNECTING)).toBeTruthy();
  });

  it('should continue normal operation if HTTP API returns no new events', () => {
    const checkForMissedEventsMock = jest.fn();

    const MockedFetchMachine = SyncMachine.withConfig({
      delays: {
        ACK_TIMEOUT: 100,
      },
      services: {
        checkForMissedEvents: checkForMissedEventsMock,
      },
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
        unchanged: () => true,
      },
      actions: {
        startStream: () => {},
      },
    });

    checkForMissedEventsMock.mockResolvedValue({
      hasNewEvents: false,
      events: [],
    });

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `done.invoke.SyncMachine.${SYNC_MACHINE_STATES.INITIALIZING}:invocation[0]`,
      // @ts-ignore
      data: { lastEventId: 999 },
    });

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.WEBSOCKET_EVENT,
      event: { type: 'CONNECTED' },
    });

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: NEW_VERTEX_ACCEPTED as unknown as FullNodeEvent,
    });

    // Simulate timeout
    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `xstate.after(ACK_TIMEOUT)#${CONNECTED_STATES.idle}`,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.checkingForMissedEvents}`)).toBeTruthy();

    // Simulate service completion with no new events
    currentState = MockedFetchMachine.transition(currentState, {
      type: 'done.invoke.checkForMissedEvents' as any,
      data: {
        hasNewEvents: false,
        events: [],
      },
    } as any);

    // Should return to idle state
    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.idle}`)).toBeTruthy();
  });

  it('should return to idle on checkForMissedEvents error', () => {
    const checkForMissedEventsMock = jest.fn();

    const MockedFetchMachine = SyncMachine.withConfig({
      delays: {
        ACK_TIMEOUT: 100,
      },
      services: {
        checkForMissedEvents: checkForMissedEventsMock,
      },
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
        unchanged: () => true,
      },
      actions: {
        startStream: () => {},
      },
    });

    checkForMissedEventsMock.mockRejectedValue(new Error('Network error'));

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `done.invoke.SyncMachine.${SYNC_MACHINE_STATES.INITIALIZING}:invocation[0]`,
      // @ts-ignore
      data: { lastEventId: 999 },
    });

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.WEBSOCKET_EVENT,
      event: { type: 'CONNECTED' },
    });

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: NEW_VERTEX_ACCEPTED as unknown as FullNodeEvent,
    });

    // Simulate timeout
    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `xstate.after(ACK_TIMEOUT)#${CONNECTED_STATES.idle}`,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.checkingForMissedEvents}`)).toBeTruthy();

    // Simulate service error
    currentState = MockedFetchMachine.transition(currentState, {
      type: 'error.platform.checkForMissedEvents' as any,
      data: new Error('Network error'),
    } as any);

    // Should return to idle state on error
    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.idle}`)).toBeTruthy();
  });
});
