/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as db from '../../src/db';
import {
  handleVertexAccepted,
  handleVoidedTx,
  handleUnvoidedTx,
  handleTxFirstBlock,
  handleVertexRemoved,
} from '../../src/services';
import { LRU } from '../../src/utils';
import { cleanDatabase } from '../utils';
import { Connection, RowDataPacket } from 'mysql2/promise';
import { Context } from '../../src/types';

/**
 * @jest-environment node
 */

// Mock the config module to enable audit logging
jest.mock('../../src/config', () => {
  const originalModule = jest.requireActual('../../src/config');
  return {
    __esModule: true,
    ...originalModule,
    default: jest.fn(() => ({
      ...originalModule.default(),
      TX_EVENT_AUDIT_ENABLED: process.env.TX_EVENT_AUDIT_ENABLED === 'true',
      NETWORK: 'testnet',
      STAGE: 'test',
      PUSH_NOTIFICATION_ENABLED: false,
    })),
  };
});

interface AuditRow extends RowDataPacket {
  id: number;
  tx_id: string;
  event_id: number;
  event_type: string;
  event_data: string;
  created_at: Date;
}

let mysql: Connection;

beforeAll(async () => {
  try {
    mysql = await db.getDbConnection();
  } catch (e) {
    console.error('Failed to establish db connection', e);
    throw e;
  }
});

afterAll(async () => {
  if (mysql) {
    await mysql.destroy();
  }
});

beforeEach(async () => {
  await cleanDatabase(mysql);
  // Enable audit logging for all tests
  process.env.TX_EVENT_AUDIT_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.TX_EVENT_AUDIT_ENABLED;
});

describe('Transaction Handler Audit Integration Tests', () => {
  const createMockContext = (eventData: any): Context => ({
    socket: null,
    healthcheck: null,
    retryAttempt: 0,
    initialEventId: 1,
    rewardMinBlocks: 10,
    txCache: new LRU(100),
    event: eventData,
  });

  describe('handleVertexAccepted with audit logging', () => {
    it('should log TX_NEW audit entry when processing a new transaction', async () => {
      expect.hasAssertions();

      const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';
      const eventId = 12345;

      const fullNodeEvent = {
        stream_id: 'test-stream',
        peer_id: 'test-peer',
        network: 'testnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: eventId,
        event: {
          id: eventId,
          timestamp: Math.floor(Date.now() / 1000),
          type: 'NEW_VERTEX_ACCEPTED',
          data: {
            hash: txId,
            timestamp: Math.floor(Date.now() / 1000),
            version: 1,
            weight: 18.0,
            nonce: BigInt(0),
            inputs: [],
            outputs: [
              {
                value: BigInt(100),
                token_data: 0,
                script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
                locked: false,
                decoded: {
                  type: 'P2PKH',
                  address: 'HBCQgVR8Xsyv1BLDjf9NJPK1Hwg4rKUh62',
                  timelock: null,
                },
              },
            ],
            parents: ['genesis1', 'genesis2'],
            tokens: [],
            token_name: null,
            token_symbol: null,
            signal_bits: 0,
            metadata: {
              hash: txId,
              voided_by: [],
              first_block: null,
              height: 0,
            },
          },
        },
      };

      const context = createMockContext(fullNodeEvent);

      await handleVertexAccepted(context, {} as any);

      // Verify audit log was created
      const [rows] = await mysql.query<AuditRow[]>(
        'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ?',
        [txId]
      );

      expect(rows.length).toBe(1);
      expect(rows[0].tx_id).toBe(txId);
      expect(rows[0].event_id).toBe(eventId);
      expect(rows[0].event_type).toBe('TX_NEW');

      const storedEventData = JSON.parse(rows[0].event_data);
      expect(storedEventData.stream_id).toBe('test-stream');
      expect(storedEventData.event.id).toBe(eventId);
    });

    it('should not log audit entry when TX_EVENT_AUDIT_ENABLED is false', async () => {
      expect.hasAssertions();

      // Disable audit logging
      process.env.TX_EVENT_AUDIT_ENABLED = 'false';

      const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';

      const fullNodeEvent = {
        stream_id: 'test-stream',
        peer_id: 'test-peer',
        network: 'testnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: 100,
        event: {
          id: 100,
          timestamp: Math.floor(Date.now() / 1000),
          type: 'NEW_VERTEX_ACCEPTED',
          data: {
            hash: txId,
            timestamp: Math.floor(Date.now() / 1000),
            version: 1,
            weight: 18.0,
            nonce: BigInt(0),
            inputs: [],
            outputs: [],
            parents: [],
            tokens: [],
            token_name: null,
            token_symbol: null,
            signal_bits: 0,
            metadata: {
              hash: txId,
              voided_by: [],
              first_block: null,
              height: 0,
            },
          },
        },
      };

      const context = createMockContext(fullNodeEvent);

      await handleVertexAccepted(context, {} as any);

      // Verify no audit log was created
      const [rows] = await mysql.query<AuditRow[]>(
        'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ?',
        [txId]
      );

      expect(rows.length).toBe(0);
    });
  });

  describe('handleVoidedTx with audit logging', () => {
    it('should log TX_VOIDED audit entry when voiding a transaction', async () => {
      expect.hasAssertions();

      const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';
      const eventId = 200;

      // First, create the transaction
      await db.addOrUpdateTx(mysql, txId, null, Math.floor(Date.now() / 1000), 1, 18.0);

      const fullNodeEvent = {
        stream_id: 'test-stream',
        peer_id: 'test-peer',
        network: 'testnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: eventId,
        event: {
          id: eventId,
          timestamp: Math.floor(Date.now() / 1000),
          type: 'VERTEX_METADATA_CHANGED',
          data: {
            hash: txId,
            timestamp: Math.floor(Date.now() / 1000),
            version: 1,
            weight: 18.0,
            nonce: BigInt(0),
            inputs: [],
            outputs: [],
            headers: [],
            parents: [],
            tokens: [],
            token_name: null,
            token_symbol: null,
            signal_bits: 0,
            metadata: {
              hash: txId,
              voided_by: ['some_other_tx'],
              first_block: null,
              height: 0,
            },
          },
        },
      };

      const context = createMockContext(fullNodeEvent);

      await handleVoidedTx(context);

      // Verify audit log was created
      const [rows] = await mysql.query<AuditRow[]>(
        'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ? AND `event_type` = ?',
        [txId, 'TX_VOIDED']
      );

      expect(rows.length).toBe(1);
      expect(rows[0].tx_id).toBe(txId);
      expect(rows[0].event_id).toBe(eventId);
      expect(rows[0].event_type).toBe('TX_VOIDED');
    });
  });

  describe('handleUnvoidedTx with audit logging', () => {
    it('should log TX_UNVOIDED audit entry when unvoiding a transaction', async () => {
      expect.hasAssertions();

      const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';
      const eventId = 300;

      // First, create a voided transaction
      await db.addOrUpdateTx(mysql, txId, null, Math.floor(Date.now() / 1000), 1, 18.0);
      await db.voidTransaction(mysql, txId);

      const fullNodeEvent = {
        stream_id: 'test-stream',
        peer_id: 'test-peer',
        network: 'testnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: eventId,
        event: {
          id: eventId,
          timestamp: Math.floor(Date.now() / 1000),
          type: 'VERTEX_METADATA_CHANGED',
          data: {
            hash: txId,
            timestamp: Math.floor(Date.now() / 1000),
            version: 1,
            weight: 18.0,
            nonce: BigInt(0),
            inputs: [],
            outputs: [],
            headers: [],
            parents: [],
            tokens: [],
            token_name: null,
            token_symbol: null,
            signal_bits: 0,
            metadata: {
              hash: txId,
              voided_by: [],
              first_block: null,
              height: 0,
            },
          },
        },
      };

      const context = createMockContext(fullNodeEvent);

      await handleUnvoidedTx(context);

      // Verify audit log was created
      const [rows] = await mysql.query<AuditRow[]>(
        'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ? AND `event_type` = ?',
        [txId, 'TX_UNVOIDED']
      );

      expect(rows.length).toBe(1);
      expect(rows[0].tx_id).toBe(txId);
      expect(rows[0].event_id).toBe(eventId);
      expect(rows[0].event_type).toBe('TX_UNVOIDED');
    });
  });

  describe('handleTxFirstBlock with audit logging', () => {
    it('should log TX_FIRST_BLOCK audit entry when transaction gets first block', async () => {
      expect.hasAssertions();

      const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';
      const eventId = 400;

      // First, create the transaction without height
      await db.addOrUpdateTx(mysql, txId, null, Math.floor(Date.now() / 1000), 1, 18.0);

      const fullNodeEvent = {
        stream_id: 'test-stream',
        peer_id: 'test-peer',
        network: 'testnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: eventId,
        event: {
          id: eventId,
          timestamp: Math.floor(Date.now() / 1000),
          type: 'VERTEX_METADATA_CHANGED',
          data: {
            hash: txId,
            timestamp: Math.floor(Date.now() / 1000),
            version: 1,
            weight: 18.0,
            nonce: BigInt(0),
            inputs: [],
            outputs: [],
            headers: [],
            parents: [],
            tokens: [],
            token_name: null,
            token_symbol: null,
            signal_bits: 0,
            metadata: {
              hash: txId,
              voided_by: [],
              first_block: 'block_hash',
              height: 100,
            },
          },
        },
      };

      const context = createMockContext(fullNodeEvent);

      await handleTxFirstBlock(context);

      // Verify audit log was created
      const [rows] = await mysql.query<AuditRow[]>(
        'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ? AND `event_type` = ?',
        [txId, 'TX_FIRST_BLOCK']
      );

      expect(rows.length).toBe(1);
      expect(rows[0].tx_id).toBe(txId);
      expect(rows[0].event_id).toBe(eventId);
      expect(rows[0].event_type).toBe('TX_FIRST_BLOCK');

      const storedEventData = JSON.parse(rows[0].event_data);
      expect(storedEventData.event.data.metadata.first_block).toBe('block_hash');
      expect(storedEventData.event.data.metadata.height).toBe(100);
    });
  });

  describe('handleVertexRemoved with audit logging', () => {
    it('should log TX_REMOVED audit entry when removing a transaction', async () => {
      expect.hasAssertions();

      const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';
      const eventId = 500;

      // First, create a voided transaction
      await db.addOrUpdateTx(mysql, txId, null, Math.floor(Date.now() / 1000), 1, 18.0);
      await db.voidTransaction(mysql, txId);

      const fullNodeEvent = {
        stream_id: 'test-stream',
        peer_id: 'test-peer',
        network: 'testnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: eventId,
        event: {
          id: eventId,
          timestamp: Math.floor(Date.now() / 1000),
          type: 'VERTEX_REMOVED',
          data: {
            hash: txId,
            timestamp: Math.floor(Date.now() / 1000),
            version: 1,
            weight: 18.0,
            nonce: BigInt(0),
            inputs: [],
            outputs: [],
            headers: [],
            parents: [],
            tokens: [],
            token_name: null,
            token_symbol: null,
            signal_bits: 0,
          },
        },
      };

      const context = createMockContext(fullNodeEvent);

      await handleVertexRemoved(context, {} as any);

      // Verify audit log was created
      const [rows] = await mysql.query<AuditRow[]>(
        'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ? AND `event_type` = ?',
        [txId, 'TX_REMOVED']
      );

      expect(rows.length).toBe(1);
      expect(rows[0].tx_id).toBe(txId);
      expect(rows[0].event_id).toBe(eventId);
      expect(rows[0].event_type).toBe('TX_REMOVED');
    });
  });

  describe('Transaction lifecycle tracking', () => {
    it('should track complete transaction lifecycle through audit logs', async () => {
      expect.hasAssertions();

      const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';

      // Step 1: Create transaction (TX_NEW)
      const newTxEvent = {
        stream_id: 'test-stream',
        peer_id: 'test-peer',
        network: 'testnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: 100,
        event: {
          id: 100,
          timestamp: Math.floor(Date.now() / 1000),
          type: 'NEW_VERTEX_ACCEPTED',
          data: {
            hash: txId,
            timestamp: Math.floor(Date.now() / 1000),
            version: 1,
            weight: 18.0,
            nonce: BigInt(0),
            inputs: [],
            outputs: [],
            parents: [],
            tokens: [],
            token_name: null,
            token_symbol: null,
            signal_bits: 0,
            metadata: {
              hash: txId,
              voided_by: [],
              first_block: null,
              height: 0,
            },
          },
        },
      };

      await handleVertexAccepted(createMockContext(newTxEvent), {} as any);

      // Step 2: Transaction gets first block (TX_FIRST_BLOCK)
      const firstBlockEvent = {
        ...newTxEvent,
        latest_event_id: 200,
        event: {
          ...newTxEvent.event,
          id: 200,
          data: {
            ...newTxEvent.event.data,
            metadata: {
              ...newTxEvent.event.data.metadata,
              first_block: 'block_hash',
              height: 100,
            },
          },
        },
      };

      await handleTxFirstBlock(createMockContext(firstBlockEvent));

      // Verify complete lifecycle
      const [rows] = await mysql.query<AuditRow[]>(
        'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ? ORDER BY `event_id` ASC',
        [txId]
      );

      expect(rows.length).toBe(2);

      // Verify first event
      expect(rows[0].event_type).toBe('TX_NEW');
      expect(rows[0].event_id).toBe(100);

      // Verify second event
      expect(rows[1].event_type).toBe('TX_FIRST_BLOCK');
      expect(rows[1].event_id).toBe(200);
    });
  });
});
