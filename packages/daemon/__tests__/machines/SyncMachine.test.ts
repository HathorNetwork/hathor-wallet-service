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
import {
  invalidPeerId,
  invalidStreamId,
  unchanged,
  voided,
} from '../../src/guards';
import { LRU } from '../../src/utils';
import EventFixtures from '../__fixtures__/events';
import { FullNodeEvent, Event, Context, EventTypes } from '../../src/types';
import { hashTxData } from '../../src/utils';
import getConfig from '../../src/config';

const { TX_CACHE_SIZE, FULLNODE_PEER_ID, STREAM_ID } = getConfig();
const { VERTEX_METADATA_CHANGED, NEW_VERTEX_ACCEPTED, REORG_STARTED } = EventFixtures;

const TxCache = new LRU(TX_CACHE_SIZE);

beforeAll(async () => {
  jest.clearAllMocks();
});

afterAll(async () => {
  TxCache.clear();
});

// @ts-ignore
const untilIdle = (machine: Machine<Context, any, Event>) => {
  let currentState = machine.initialState;

  expect(currentState.matches(SYNC_MACHINE_STATES.INITIALIZING)).toBeTruthy();

  currentState = machine.transition(currentState, {
    // @ts-ignore
    type: `done.invoke.SyncMachine.${SYNC_MACHINE_STATES.INITIALIZING}:invocation[0]`,
    // @ts-ignore
    data: { lastEventId: 999 },
  });

  expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTING}`)).toBeTruthy();
  expect(currentState.context.initialEventId).toStrictEqual(999);

  currentState = machine.transition(currentState, {
    type: EventTypes.WEBSOCKET_EVENT,
    event: { type: 'CONNECTED' },
  });

  expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.idle}`)).toBeTruthy();

  return currentState;
};

describe('machine initialization', () => {
  it('should fetch initial state, connect to websocket and validate network before transitioning to idle', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      actions: {
        startStream: () => { },
      },
    });

    let currentState = MockedFetchMachine.initialState;

    expect(currentState.matches(SYNC_MACHINE_STATES.INITIALIZING)).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `done.invoke.SyncMachine.${SYNC_MACHINE_STATES.INITIALIZING}:invocation[0]`,
      // @ts-ignore
      data: { lastEventId: 999 },
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTING}`)).toBeTruthy();
    expect(currentState.context.initialEventId).toStrictEqual(999);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.WEBSOCKET_EVENT,
      event: { type: 'CONNECTED' },
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.idle}`)).toBeTruthy();
  });

  it('should transition to RECONNECTING if the websocket fails to initialize', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      delays: {
        RETRY_BACKOFF_INCREASE: 100,
      },
    });

    let currentState = MockedFetchMachine.initialState;

    expect(currentState.matches(SYNC_MACHINE_STATES.INITIALIZING)).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `done.invoke.SyncMachine.${SYNC_MACHINE_STATES.INITIALIZING}:invocation[0]`,
      // @ts-ignore
      data: { lastEventId: 999 },
    });

    expect(currentState.matches(SYNC_MACHINE_STATES.CONNECTING)).toBeTruthy();
    expect(currentState.context.initialEventId).toStrictEqual(999);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.WEBSOCKET_EVENT,
      event: {
        type: 'DISCONNECTED',
      }
    });

    expect(currentState.matches(SYNC_MACHINE_STATES.RECONNECTING)).toBeTruthy();
  });

  it('should transition to CONNECTING to reconnect after a failure in the initial connection', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      delays: {
        RETRY_BACKOFF_INCREASE: 100,
      },
    });

    let currentState = MockedFetchMachine.initialState;

    expect(currentState.matches(SYNC_MACHINE_STATES.INITIALIZING)).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `done.invoke.SyncMachine.${SYNC_MACHINE_STATES.INITIALIZING}:invocation[0]`,
      // @ts-ignore
      data: { lastEventId: 999 },
    });

    expect(currentState.matches(SYNC_MACHINE_STATES.CONNECTING)).toBeTruthy();
    expect(currentState.context.initialEventId).toStrictEqual(999);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.WEBSOCKET_EVENT,
      event: { type: 'DISCONNECTED', }
    });

    expect(currentState.matches(SYNC_MACHINE_STATES.RECONNECTING)).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `xstate.after(BACKOFF_DELAYED_RECONNECT)#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
    });

    expect(currentState.matches('CONNECTING')).toBeTruthy();
  });

  it('should transition to RECONNECTING to reconnect after a failure', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      actions: {
        startStream: () => { },
      },
    });

    let currentState = MockedFetchMachine.initialState;

    expect(currentState.matches(SYNC_MACHINE_STATES.INITIALIZING)).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: `done.invoke.SyncMachine.${SYNC_MACHINE_STATES.INITIALIZING}:invocation[0]`,
      // @ts-ignore
      data: { lastEventId: 999 },
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTING}`)).toBeTruthy();
    expect(currentState.context.initialEventId).toStrictEqual(999);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.WEBSOCKET_EVENT,
      event: { type: 'CONNECTED' },
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.idle}`)).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.WEBSOCKET_EVENT,
      event: {
        type: 'DISCONNECTED',
      },
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.RECONNECTING}`)).toBeTruthy();
  });
});

describe('Event handling', () => {
  let originalFullNodePeerId: string | undefined;
  let originalStreamId: string | undefined;

  beforeAll(() => {
    originalFullNodePeerId = FULLNODE_PEER_ID;
    originalStreamId = STREAM_ID;
  });

  afterEach(() => {
    // Restore the original values after each test
    process.env.FULLNODE_PEER_ID = originalFullNodePeerId;
    process.env.STREAM_ID = originalStreamId;
  });

  it('should validate the peerid on every message', () => {
    process.env.FULLNODE_PEER_ID = 'invalidPeerId';

    const MockedFetchMachine = SyncMachine.withConfig({
      actions: {
        startStream: () => {},
      },
      guards: {
        invalidPeerId,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
      },
    });

    let currentState = untilIdle(MockedFetchMachine);

    // Manually initialize txCache since untilIdle doesn't execute entry actions
    if (!currentState.context.txCache) {
      currentState.context.txCache = new LRU(TX_CACHE_SIZE);
    }

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches(SYNC_MACHINE_STATES.ERROR)).toBeTruthy();
  });

  it('should validate the stream id on every message', () => {
    process.env.STREAM_ID = 'invalidStreamId';

    const MockedFetchMachine = SyncMachine.withConfig({
      actions: {
        startStream: () => {},
      },
      guards: {
        invalidPeerId: () => false,
        invalidStreamId,
        invalidNetwork: () => false,
      },
    });

    let currentState = untilIdle(MockedFetchMachine);

    // Manually initialize txCache since untilIdle doesn't execute entry actions
    if (!currentState.context.txCache) {
      currentState.context.txCache = new LRU(TX_CACHE_SIZE);
    }

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches(SYNC_MACHINE_STATES.ERROR)).toBeTruthy();
  });

  it('should ignore already processed transactions', () => {
    const unchangedMock = jest.fn();
    const sendAckMock = jest.fn();
    const MockedFetchMachine = SyncMachine.withConfig({
      actions: {
        sendAck: sendAckMock,
      },
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
        unchanged: unchangedMock,
      },
    });

    unchangedMock.mockImplementation(unchanged);

    let currentState = untilIdle(MockedFetchMachine);

    // Manually initialize txCache since untilIdle doesn't execute entry actions
    if (!currentState.context.txCache) {
      currentState.context.txCache = new LRU(TX_CACHE_SIZE);
    }
    const machineCache = currentState.context.txCache;

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.idle}`)).toBeTruthy();

    const hashedTx = hashTxData(VERTEX_METADATA_CHANGED.event.data.metadata);
    machineCache.set(VERTEX_METADATA_CHANGED.event.data.hash, hashedTx);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    // Should still be in the idle state:
    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.idle}`)).toBeTruthy();

    // Should have called the unchanged guard
    expect(unchangedMock).toHaveBeenCalledTimes(1);
    expect(unchangedMock).toHaveReturnedWith(true);

    // @ts-ignore: last event id should be the event we sent
    expect(currentState.context.event.event.id).toStrictEqual(VERTEX_METADATA_CHANGED.event.id);

    machineCache.clear();

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingMetadataChanged}`)).toBeTruthy();
    expect(unchangedMock).toHaveBeenCalledTimes(2);
    expect(unchangedMock).toHaveReturnedWith(false);
    // @ts-ignore
    expect(currentState.context.event.event.id).toStrictEqual(VERTEX_METADATA_CHANGED.event.id);
  });

  it('should transition to handlingVoidedTx if TX_VOIDED action is received from diff detector', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
      },
    });

    let currentState = untilIdle(MockedFetchMachine);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingMetadataChanged}.detectingDiff`)).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.METADATA_DECIDED,
      event: {
        type: 'TX_VOIDED',
        originalEvent: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
      },
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingVoidedTx}`)).toBeTruthy();
  });

  it('should transition to handlingUnvoidedTx if TX_UNVOIDED action is received from diff detector', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
      },
    });

    let currentState = untilIdle(MockedFetchMachine);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingMetadataChanged}.detectingDiff`)).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.METADATA_DECIDED,
      event: {
        type: 'TX_UNVOIDED',
        originalEvent: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
      },
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingUnvoidedTx}`)).toBeTruthy();
  });

  it('should transition to handlingVertexAccepted if TX_NEW action is received from diff detector', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
      },
    });

    let currentState = untilIdle(MockedFetchMachine);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingMetadataChanged}.detectingDiff`)).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.METADATA_DECIDED,
      event: {
        type: 'TX_NEW',
        originalEvent: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
      }
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingVertexAccepted}`)).toBeTruthy();
  });

  it('should transition to handlingFirstBlock if TX_FIRST_BLOCK action is received from diff detector', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
      },
    });

    let currentState = untilIdle(MockedFetchMachine);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingMetadataChanged}.detectingDiff`)).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: EventTypes.METADATA_DECIDED,
      event: {
        type: 'TX_FIRST_BLOCK',
        originalEvent: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
      }
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingFirstBlock}`)).toBeTruthy();
  });

  it('should transition to handlingUnhandledEvent if IGNORE action is received from diff detector', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
      },
    });

    let currentState = untilIdle(MockedFetchMachine);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingMetadataChanged}.detectingDiff`)).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: EventTypes.METADATA_DECIDED,
      event: {
        type: 'IGNORE',
        originalEvent: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
      }
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingUnhandledEvent}`)).toBeTruthy();
  });

  it('should ignore NEW_VERTEX_ACCEPTED events if the transaction is already voided', () => {
    const voidedGuardMock = jest.fn();
    const MockedFetchMachine = SyncMachine.withConfig({
      guards: {
        voided: voidedGuardMock,
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
      },
    });

    voidedGuardMock.mockImplementation(voided);

    let currentState = untilIdle(MockedFetchMachine);

    const VOIDED_NEW_VERTEX_ACCEPTED = { ...NEW_VERTEX_ACCEPTED };
    // @ts-ignore
    VOIDED_NEW_VERTEX_ACCEPTED.event.data.metadata.voided_by = ['tx1'];

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: VOIDED_NEW_VERTEX_ACCEPTED as unknown as FullNodeEvent,
    });

    expect(voidedGuardMock).toHaveBeenCalledTimes(1);
    expect(voidedGuardMock).toHaveReturnedWith(true);

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.idle}`)).toBeTruthy();
  });

  it('should ignore unhandled events but still send ack', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
      },
    });

    let currentState = untilIdle(MockedFetchMachine);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: {
        type: 'EVENT',
        event: {
          peer_id: '123',
          id: 38,
          timestamp: 1,
          type: 'FULLNODE_EXPLODED',
        },
      } as unknown as FullNodeEvent,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingUnhandledEvent}`)).toBeTruthy();
  });

  it('should handle REORG_STARTED event', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      guards: {
        invalidPeerId: () => false,
        invalidStreamId: () => false,
        invalidNetwork: () => false,
      },
    });

    let currentState = untilIdle(MockedFetchMachine);

    currentState = MockedFetchMachine.transition(currentState, {
      type: EventTypes.FULLNODE_EVENT,
      event: REORG_STARTED as unknown as FullNodeEvent,
    });

    expect(currentState.matches(`${SYNC_MACHINE_STATES.CONNECTED}.${CONNECTED_STATES.handlingReorgStarted}`)).toBeTruthy();
  });
});
