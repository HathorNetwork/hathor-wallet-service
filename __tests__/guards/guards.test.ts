import { Context, Event } from '../../src/machines/types';
import {
  metadataIgnore,
  metadataVoided,
  metadataNewTx,
  metadataFirstBlock,
  metadataChanged,
  vertexAccepted,
  invalidPeerId,
  invalidStreamId,
  websocketDisconnected,
  voided,
  unchanged,
} from '../../src/guards';

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

const generateFullNodeEvent = (type: string, data = {} as any): Event => ({
  type: 'FULLNODE_EVENT',
  event: {
    type: 'EVENT',
    event: {
      peer_id: '',
      id: 0,
      timestamp: 0,
      type,
      data,
    },
    stream_id: '',
    latest_event_id: 0,
  },
});

const generateMetadataDecidedEvent = (type: string): Event => ({
  type: 'METADATA_DECIDED',
  event: {
    type,
    // @ts-ignore
    originalEvent: {} as any,
  },
});

describe('metadata decided tests', () => {
  test('metadataIgnore', () => {
    expect(metadataIgnore(mockContext, generateMetadataDecidedEvent('IGNORE'))).toBe(true);
    expect(metadataIgnore(mockContext, generateMetadataDecidedEvent('TX_NEW'))).toBe(false);
    expect(metadataIgnore(mockContext, generateMetadataDecidedEvent('TX_VOIDED'))).toBe(false);
    expect(metadataIgnore(mockContext, generateMetadataDecidedEvent('TX_FIRST_BLOCK'))).toBe(false);

    // Any event other than METADATA_DECIDED should return false:
    expect(metadataIgnore(mockContext, generateFullNodeEvent('VERTEX_METADATA_CHANGED'))).toBe(false);
  });

  test('metadataVoided', () => {
    expect(metadataVoided(mockContext, generateMetadataDecidedEvent('TX_VOIDED'))).toBe(true);
    expect(metadataVoided(mockContext, generateMetadataDecidedEvent('IGNORE'))).toBe(false);
    expect(metadataVoided(mockContext, generateMetadataDecidedEvent('TX_NEW'))).toBe(false);
    expect(metadataVoided(mockContext, generateMetadataDecidedEvent('TX_FIRST_BLOCK'))).toBe(false);

    // Any event other than METADATA_DECIDED should return false:
    expect(metadataVoided(mockContext, generateFullNodeEvent('VERTEX_METADATA_CHANGED'))).toBe(false);
  });

  test('metadataNewTx', () => {
    expect(metadataNewTx(mockContext, generateMetadataDecidedEvent('TX_NEW'))).toBe(true);
    expect(metadataNewTx(mockContext, generateMetadataDecidedEvent('TX_FIRST_BLOCK'))).toBe(false);
    expect(metadataNewTx(mockContext, generateMetadataDecidedEvent('TX_VOIDED'))).toBe(false);
    expect(metadataNewTx(mockContext, generateMetadataDecidedEvent('IGNORE'))).toBe(false);

    // Any event other than METADATA_DECIDED should return false:
    expect(metadataNewTx(mockContext, generateFullNodeEvent('VERTEX_METADATA_CHANGED'))).toBe(false);
  });

  test('metadataFirstBlock', () => {
    expect(metadataFirstBlock(mockContext, generateMetadataDecidedEvent('TX_FIRST_BLOCK'))).toBe(true);
    expect(metadataFirstBlock(mockContext, generateMetadataDecidedEvent('TX_VOIDED'))).toBe(false);
    expect(metadataFirstBlock(mockContext, generateMetadataDecidedEvent('IGNORE'))).toBe(false);
    expect(metadataFirstBlock(mockContext, generateMetadataDecidedEvent('TX_NEW'))).toBe(false);

    // Any event other than METADATA_DECIDED should return false:
    expect(metadataFirstBlock(mockContext, generateFullNodeEvent('VERTEX_METADATA_CHANGED'))).toBe(false);
  });
});

describe('fullnode event guards', () => {
  test('vertexAccepted', () => {
    expect(vertexAccepted(mockContext, generateFullNodeEvent('NEW_VERTEX_ACCEPTED'))).toBe(true);
    expect(vertexAccepted(mockContext, generateFullNodeEvent('VERTEX_METADATA_CHANGED'))).toBe(false);

    // Any event other than FULLNODE_EVENT should return false
    expect(vertexAccepted(mockContext, generateMetadataDecidedEvent('TX_NEW'))).toBe(false);
  });

  test('metadataChanged', () => {
    expect(metadataChanged(mockContext, generateFullNodeEvent('VERTEX_METADATA_CHANGED'))).toBe(true);
    expect(metadataChanged(mockContext, generateFullNodeEvent('NEW_VERTEX_ACCEPTED'))).toBe(false);

    // Any event other than FULLNODE_EVENT should return false
    expect(metadataChanged(mockContext, generateMetadataDecidedEvent('IGNORE'))).toBe(false);
  });

  test('voided', () => {
    const fullNodeVoidedTxEvent = generateFullNodeEvent('VERTEX_METADATA_CHANGED', {
      hash: 'tx1',
      metadata: {
        voided_by: ['tx2'],
      }
    });
    const fullNodeNotVoidedEvent = generateFullNodeEvent('VERTEX_METADATA_CHANGED', {
      hash: 'tx1',
      metadata: {
        voided_by: [],
      }
    });

    expect(voided(mockContext, fullNodeVoidedTxEvent)).toBe(true);
    expect(voided(mockContext, fullNodeNotVoidedEvent)).toBe(false);

    // Any event other than FULLNODE_EVENT should return false
    expect(voided(mockContext, generateMetadataDecidedEvent('TX_NEW'))).toBe(false);

    // Any fullndode event other VERTEX_METADATA_CHANGED and NEW_VERTEX_ACCEPTED
    // should return false
    expect(voided(mockContext, generateFullNodeEvent('SOMETHING_ELSE'))).toBe(false);
  });

  test('unchanged', () => {
    const fullNodeEvent = generateFullNodeEvent('VERTEX_METADATA_CHANGED');

    // @ts-ignore
    TxCache.get.mockReturnValueOnce('mockedTxCache');
    // @ts-ignore
    hashTxData.mockReturnValueOnce('mockedTxCache');

    expect(unchanged(mockContext, fullNodeEvent)).toBe(true);
    // Since I only mocked the return once, this should fail on next call:
    expect(unchanged(mockContext, fullNodeEvent)).toBe(false);

    // Any event other than FULLNODE_EVENT should return false
    expect(unchanged(mockContext, generateMetadataDecidedEvent('TX_NEW'))).toBe(true);
  });

  test('unchanged', () => {
    const fullNodeEvent = generateFullNodeEvent('VERTEX_METADATA_CHANGED');

    // @ts-ignore
    TxCache.get.mockReturnValueOnce('mockedTxCache');
    // @ts-ignore
    hashTxData.mockReturnValueOnce('mockedTxCache');

    expect(unchanged(mockContext, fullNodeEvent)).toBe(true);
    // Since I only mocked the return once, this should fail on next call:
    expect(unchanged(mockContext, fullNodeEvent)).toBe(false);

    // Any event other than FULLNODE_EVENT should return false
    expect(unchanged(mockContext, generateMetadataDecidedEvent('TX_NEW'))).toBe(true);
  });
});

describe('fullnode validation guards', () => {
  test('invalidStreamId', () => {
    // @ts-ignore
    getConfig.mockReturnValueOnce({
      STREAM_ID: 'mockStreamId',
    });
    const fullNodeEvent = generateFullNodeEvent('NEW_VERTEX_ACCEPTED');
    // @ts-ignore
    fullNodeEvent.event.stream_id = 'mockStreamId';
    expect(invalidStreamId(mockContext, fullNodeEvent)).toBe(false);
    // @ts-ignore
    fullNodeEvent.event.stream_id = 'invalidStreamId';
    expect(invalidStreamId(mockContext, fullNodeEvent)).toBe(true);
  });

  test('invalidPeerId', () => {
    // @ts-ignore
    getConfig.mockReturnValueOnce({
      FULLNODE_PEER_ID: 'mockPeerId',
    });

    const fullNodeEvent = generateFullNodeEvent('NEW_VERTEX_ACCEPTED');
    // @ts-ignore
    fullNodeEvent.event.event.peer_id = 'mockPeerId';
    expect(invalidPeerId(mockContext, fullNodeEvent)).toBe(false);
    // @ts-ignore
    fullNodeEvent.event.event.peer_id = 'invalidPeerId';
    expect(invalidPeerId(mockContext, fullNodeEvent)).toBe(true);
  });
});

describe('websocket guards', () => {
  test('websocketDisconnected', () => {
    const mockDisconnectedEvent: Event = {
      type: 'WEBSOCKET_EVENT',
      event: { type: 'DISCONNECTED' }
    };
    const mockConnectedEvent: Event = {
      type: 'WEBSOCKET_EVENT',
      event: { type: 'CONNECTED' }
    };

    expect(websocketDisconnected(mockContext, mockDisconnectedEvent)).toBe(true);
    expect(websocketDisconnected(mockContext, mockConnectedEvent)).toBe(false);
  });
});
