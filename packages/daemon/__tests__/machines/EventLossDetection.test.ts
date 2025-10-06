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

describe('Event Loss Detection - Unit Tests', () => {
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

  it('should have checkingForMissedEvents state in machine definition', () => {
    const machine = SyncMachine.withConfig({
      actions: { startStream: () => {} },
    });

    const connectedState = machine.states[SYNC_MACHINE_STATES.CONNECTED];
    expect(connectedState).toBeDefined();
    // @ts-ignore
    expect(connectedState.states[CONNECTED_STATES.checkingForMissedEvents]).toBeDefined();
  });

  it('should configure checkForMissedEvents service in checkingForMissedEvents state', () => {
    const machine = SyncMachine.withConfig({
      actions: { startStream: () => {} },
    });

    const connectedState = machine.states[SYNC_MACHINE_STATES.CONNECTED];
    // @ts-ignore
    const checkingState = connectedState.states[CONNECTED_STATES.checkingForMissedEvents];

    expect(checkingState.invoke).toBeDefined();
    // @ts-ignore
    const invokeSrc = Array.isArray(checkingState.invoke) ? checkingState.invoke[0].src : checkingState.invoke.src;
    expect(invokeSrc).toBe('checkForMissedEvents');
  });

  it('should have all required services, guards, delays, and actions configured', () => {
    expect(SyncMachine.options.services).toHaveProperty('checkForMissedEvents');
    expect(SyncMachine.options.guards).toHaveProperty('hasNewEvents');
    expect(SyncMachine.options.delays).toHaveProperty('ACK_TIMEOUT');
    expect(SyncMachine.options.actions).toHaveProperty('startAckTimeout');
    expect(SyncMachine.options.actions).toHaveProperty('cancelAckTimeout');
  });
});
