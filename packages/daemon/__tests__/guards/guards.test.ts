import { Context, Event, FullNodeEventTypes } from '../../src/types';
import {
  nextChangeIsVoided,
  nextChangeIsUnvoided,
  nextChangeIsNewTx,
  nextChangeIsFirstBlock,
  nextChangeIsNcExecVoided,
  metadataChanged,
  vertexAccepted,
  invalidPeerId,
  invalidStreamId,
  websocketDisconnected,
  voided,
  unchanged,
  invalidNetwork,
  reorgStarted,
  tokenCreated,
  hasNewEvents,
} from '../../src/guards';
import { EventTypes } from '../../src/types';

jest.mock('../../src/utils', () => ({
  hashTxData: jest.fn(),
}));

import { hashTxData } from '../../src/utils';

jest.mock('../../src/config', () => {
  return {
    __esModule: true, // This property is needed for mocking a default export
    default: jest.fn(() => ({})),
  };
});

import getConfig from '../../src/config';

const TxCache = {
  get: jest.fn(),
  set: jest.fn(),
};

const mockContext: Context = {
  socket: null,
  retryAttempt: 0,
  // @ts-ignore
  event: {},
  initialEventId: null,
  // @ts-ignore
  txCache: TxCache,
};

const generateStandardFullNodeEvent = (type: Exclude<FullNodeEventTypes, FullNodeEventTypes.REORG_STARTED>, data = {} as any): Event => ({
  type: EventTypes.FULLNODE_EVENT,
  event: {
    type: 'EVENT',
    network: 'mainnet',
    peer_id: '',
    stream_id: '',
    event: {
      id: 0,
      timestamp: 0,
      type,
      data,
    },
    latest_event_id: 0,
  },
} as Event);

const generateReorgStartedEvent = (data = {
  reorg_size: 1,
  previous_best_block: 'prev',
  new_best_block: 'new',
  common_block: 'common',
}): Event => ({
  type: EventTypes.FULLNODE_EVENT,
  event: {
    type: 'EVENT',
    network: 'mainnet',
    peer_id: '',
    stream_id: '',
    event: {
      id: 0,
      timestamp: 0,
      type: FullNodeEventTypes.REORG_STARTED,
      data,
      group_id: 1,
    },
    latest_event_id: 0,
  },
});

const generateFullNodeEvent = (type: FullNodeEventTypes, data = {} as any): Event => {
  if (type === FullNodeEventTypes.REORG_STARTED) {
    return generateReorgStartedEvent(data);
  }
  if (type === FullNodeEventTypes.NC_EVENT) {
    throw new Error('Unsuported generation');
  }
  return generateStandardFullNodeEvent(type, data);
};

describe('metadata dispatch queue guards', () => {
  const contextWithChange = (changeType: string): Context => ({
    ...mockContext,
    pendingMetadataChanges: [changeType],
  });

  const emptyContext: Context = {
    ...mockContext,
    pendingMetadataChanges: [],
  };

  test('nextChangeIsVoided', () => {
    expect(nextChangeIsVoided(contextWithChange('TX_VOIDED'))).toBe(true);
    expect(nextChangeIsVoided(contextWithChange('TX_NEW'))).toBe(false);
    expect(nextChangeIsVoided(emptyContext)).toBe(false);
  });

  test('nextChangeIsUnvoided', () => {
    expect(nextChangeIsUnvoided(contextWithChange('TX_UNVOIDED'))).toBe(true);
    expect(nextChangeIsUnvoided(contextWithChange('TX_VOIDED'))).toBe(false);
    expect(nextChangeIsUnvoided(emptyContext)).toBe(false);
  });

  test('nextChangeIsNewTx', () => {
    expect(nextChangeIsNewTx(contextWithChange('TX_NEW'))).toBe(true);
    expect(nextChangeIsNewTx(contextWithChange('TX_VOIDED'))).toBe(false);
    expect(nextChangeIsNewTx(emptyContext)).toBe(false);
  });

  test('nextChangeIsFirstBlock', () => {
    expect(nextChangeIsFirstBlock(contextWithChange('TX_FIRST_BLOCK'))).toBe(true);
    expect(nextChangeIsFirstBlock(contextWithChange('TX_VOIDED'))).toBe(false);
    expect(nextChangeIsFirstBlock(emptyContext)).toBe(false);
  });

  test('nextChangeIsNcExecVoided', () => {
    expect(nextChangeIsNcExecVoided(contextWithChange('NC_EXEC_VOIDED'))).toBe(true);
    expect(nextChangeIsNcExecVoided(contextWithChange('TX_VOIDED'))).toBe(false);
    expect(nextChangeIsNcExecVoided(emptyContext)).toBe(false);
  });

  test('guards return false when pendingMetadataChanges is undefined', () => {
    const ctx = { ...mockContext, pendingMetadataChanges: undefined };
    expect(nextChangeIsVoided(ctx)).toBe(false);
    expect(nextChangeIsUnvoided(ctx)).toBe(false);
    expect(nextChangeIsNewTx(ctx)).toBe(false);
    expect(nextChangeIsFirstBlock(ctx)).toBe(false);
    expect(nextChangeIsNcExecVoided(ctx)).toBe(false);
  });
});

describe('fullnode event guards', () => {
  test('vertexAccepted', () => {
    expect(vertexAccepted(mockContext, generateFullNodeEvent(FullNodeEventTypes.NEW_VERTEX_ACCEPTED))).toBe(true);
    expect(vertexAccepted(mockContext, generateFullNodeEvent(FullNodeEventTypes.VERTEX_METADATA_CHANGED))).toBe(false);

    // Any event other than FULLNODE_EVENT should return false
    expect(() => vertexAccepted(mockContext, { type: EventTypes.WEBSOCKET_EVENT, event: { type: 'CONNECTED' } } as Event)).toThrow('Invalid event type on vertexAccepted guard: WEBSOCKET_EVENT');
  });

  test('metadataChanged', () => {
    expect(metadataChanged(mockContext, generateFullNodeEvent(FullNodeEventTypes.VERTEX_METADATA_CHANGED))).toBe(true);
    expect(metadataChanged(mockContext, generateFullNodeEvent(FullNodeEventTypes.NEW_VERTEX_ACCEPTED))).toBe(false);

    // Any event other than FULLNODE_EVENT should return false
    expect(() => metadataChanged(mockContext, { type: EventTypes.WEBSOCKET_EVENT, event: { type: 'CONNECTED' } } as Event)).toThrow('Invalid event type on metadataChanged guard: WEBSOCKET_EVENT');
  });

  test('voided', () => {
    const fullNodeVoidedTxEvent = generateFullNodeEvent(FullNodeEventTypes.VERTEX_METADATA_CHANGED, {
      hash: 'tx1',
      metadata: {
        voided_by: ['tx2'],
      }
    });
    const fullNodeNotVoidedEvent = generateFullNodeEvent(FullNodeEventTypes.VERTEX_METADATA_CHANGED, {
      hash: 'tx1',
      metadata: {
        voided_by: [],
      }
    });

    expect(voided(mockContext, fullNodeVoidedTxEvent)).toBe(true);
    expect(voided(mockContext, fullNodeNotVoidedEvent)).toBe(false);

    // Any event other than FULLNODE_EVENT should return false
    expect(() => voided(mockContext, { type: EventTypes.WEBSOCKET_EVENT, event: { type: 'CONNECTED' } } as Event)).toThrow('Invalid event type on voided guard: WEBSOCKET_EVENT');

    // Any fullndode event other VERTEX_METADATA_CHANGED and NEW_VERTEX_ACCEPTED
    // should return false
    // @ts-ignore
    expect(voided(mockContext, generateFullNodeEvent('SOMETHING_ELSE'))).toBe(false);
  });

  test('unchanged', () => {
    const fullNodeEvent = generateFullNodeEvent(FullNodeEventTypes.VERTEX_METADATA_CHANGED);

    // @ts-ignore
    TxCache.get.mockReturnValueOnce('mockedTxCache');
    // @ts-ignore
    hashTxData.mockReturnValueOnce('mockedTxCache');

    expect(unchanged(mockContext, fullNodeEvent)).toBe(true);
    // Since I only mocked the return once, this should fail on next call:
    expect(unchanged(mockContext, fullNodeEvent)).toBe(false);

    // Any event other than FULLNODE_EVENT should return false
    expect(() => unchanged(mockContext, { type: EventTypes.WEBSOCKET_EVENT, event: { type: 'CONNECTED' } } as Event)).toThrow('Invalid event type on unchanged guard: WEBSOCKET_EVENT');
  });

  test('reorgStarted', () => {
    expect(reorgStarted(mockContext, generateFullNodeEvent(FullNodeEventTypes.REORG_STARTED))).toBe(true);
    expect(reorgStarted(mockContext, generateFullNodeEvent(FullNodeEventTypes.VERTEX_METADATA_CHANGED))).toBe(false);

    // Any event other than FULLNODE_EVENT should throw
    expect(() => reorgStarted(mockContext, { type: EventTypes.WEBSOCKET_EVENT, event: { type: 'CONNECTED' } } as Event)).toThrow('Invalid event type on reorgStarted guard: WEBSOCKET_EVENT');
  });

  test('tokenCreated', () => {
    expect(tokenCreated(mockContext, generateFullNodeEvent(FullNodeEventTypes.TOKEN_CREATED))).toBe(true);
    expect(tokenCreated(mockContext, generateFullNodeEvent(FullNodeEventTypes.NEW_VERTEX_ACCEPTED))).toBe(false);
    expect(tokenCreated(mockContext, generateFullNodeEvent(FullNodeEventTypes.VERTEX_METADATA_CHANGED))).toBe(false);
    expect(tokenCreated(mockContext, generateFullNodeEvent(FullNodeEventTypes.REORG_STARTED))).toBe(false);

    // Any event other than FULLNODE_EVENT should throw
    expect(() => tokenCreated(mockContext, { type: EventTypes.WEBSOCKET_EVENT, event: { type: 'CONNECTED' } } as Event)).toThrow('Invalid event type on tokenCreated guard: WEBSOCKET_EVENT');
  });
});

describe('fullnode validation guards', () => {
  test('invalidStreamId', () => {
    // @ts-ignore
    getConfig.mockReturnValueOnce({
      STREAM_ID: 'mockStreamId',
    });
    const fullNodeEvent = generateFullNodeEvent(FullNodeEventTypes.NEW_VERTEX_ACCEPTED);
    // @ts-ignore
    fullNodeEvent.event.stream_id = 'mockStreamId';
    expect(invalidStreamId(mockContext, fullNodeEvent)).toBe(false);
    // @ts-ignore
    fullNodeEvent.event.stream_id = 'invalidStreamId';
    expect(invalidStreamId(mockContext, fullNodeEvent)).toBe(true);
  });

  test('invalidNetwork', () => {
    // @ts-ignore
    getConfig.mockReturnValue({
      FULLNODE_NETWORK: 'mainnet',
    });
    const fullNodeEvent = generateFullNodeEvent(FullNodeEventTypes.NEW_VERTEX_ACCEPTED);
    // @ts-ignore
    fullNodeEvent.event.network = 'mainnet';
    expect(invalidNetwork(mockContext, fullNodeEvent)).toBe(false);
    // @ts-ignore
    fullNodeEvent.event.network = 'testnet';
    expect(invalidNetwork(mockContext, fullNodeEvent)).toBe(true);
  });

  test('invalidPeerId', () => {
    // @ts-ignore
    getConfig.mockReturnValueOnce({
      FULLNODE_PEER_ID: 'mockPeerId',
    });

    const fullNodeEvent = generateFullNodeEvent(FullNodeEventTypes.NEW_VERTEX_ACCEPTED);
    // @ts-ignore
    fullNodeEvent.event.peer_id = 'mockPeerId';
    expect(invalidPeerId(mockContext, fullNodeEvent)).toBe(false);
    // @ts-ignore
    fullNodeEvent.event.peer_id = 'invalidPeerId';
    expect(invalidPeerId(mockContext, fullNodeEvent)).toBe(true);
  });
});

describe('websocket guards', () => {
  test('websocketDisconnected', () => {
    const mockDisconnectedEvent: Event = {
      type: EventTypes.WEBSOCKET_EVENT,
      event: { type: 'DISCONNECTED' }
    };
    const mockConnectedEvent: Event = {
      type: EventTypes.WEBSOCKET_EVENT,
      event: { type: 'CONNECTED' }
    };

    expect(websocketDisconnected(mockContext, mockDisconnectedEvent)).toBe(true);
    expect(websocketDisconnected(mockContext, mockConnectedEvent)).toBe(false);
  });
});

describe('event loss detection guards', () => {
  test('hasNewEvents returns true when data.hasNewEvents is true', () => {
    const mockEvent = {
      data: {
        hasNewEvents: true,
        events: [{ id: 1 }, { id: 2 }],
      },
    };

    expect(hasNewEvents(mockContext, mockEvent)).toBe(true);
  });

  test('hasNewEvents returns false when data.hasNewEvents is false', () => {
    const mockEvent = {
      data: {
        hasNewEvents: false,
        events: [],
      },
    };

    expect(hasNewEvents(mockContext, mockEvent)).toBe(false);
  });

  test('hasNewEvents returns false when data is missing', () => {
    const mockEvent = {};

    expect(hasNewEvents(mockContext, mockEvent)).toBe(false);
  });

  test('hasNewEvents returns false when data is null', () => {
    const mockEvent = {
      data: null,
    };

    expect(hasNewEvents(mockContext, mockEvent)).toBe(false);
  });

  test('hasNewEvents returns false when hasNewEvents is undefined', () => {
    const mockEvent = {
      data: {
        events: [],
      },
    };

    expect(hasNewEvents(mockContext, mockEvent)).toBe(false);
  });
});
