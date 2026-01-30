/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { getDbConnection, logTxEventAudit } from '../../src/db';
import { Connection, RowDataPacket } from 'mysql2/promise';
import { cleanDatabase } from '../utils';

// Mock the config module
jest.mock('../../src/config', () => {
  const originalModule = jest.requireActual('../../src/config');
  return {
    __esModule: true,
    ...originalModule,
    default: jest.fn(() => ({
      ...originalModule.default(),
      TX_EVENT_AUDIT_ENABLED: process.env.TX_EVENT_AUDIT_ENABLED === 'true',
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

// Use a single mysql connection for all tests
let mysql: Connection;

beforeAll(async () => {
  try {
    mysql = await getDbConnection();
  } catch (e) {
    console.error('Failed to establish db connection', e);
    throw e;
  }
});

afterAll(() => {
  mysql.destroy();
});

beforeEach(async () => {
  await cleanDatabase(mysql);
  // Reset the environment variable before each test
  delete process.env.TX_EVENT_AUDIT_ENABLED;
});

describe('logTxEventAudit', () => {
  test('should not insert audit log when TX_EVENT_AUDIT_ENABLED is false', async () => {
    expect.hasAssertions();

    // Explicitly set to false
    process.env.TX_EVENT_AUDIT_ENABLED = 'false';

    const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';
    const eventId = 12345;
    const eventType = 'TX_NEW';
    const eventData = {
      stream_id: 'test-stream',
      peer_id: 'test-peer',
      network: 'testnet',
      type: 'FULLNODE_EVENT',
      latest_event_id: 12345,
      event: {
        id: 12345,
        timestamp: 1234567890,
        type: 'NEW_VERTEX_ACCEPTED',
        data: {
          hash: txId,
          timestamp: 1234567890,
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

    await logTxEventAudit(mysql, txId, eventId, eventType, eventData);

    // Verify no audit log was created
    const [rows] = await mysql.query<AuditRow[]>(
      'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ?',
      [txId]
    );

    expect(rows.length).toBe(0);
  });

  test('should not insert audit log when TX_EVENT_AUDIT_ENABLED is not set', async () => {
    expect.hasAssertions();

    // Don't set the environment variable at all
    const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';
    const eventId = 12345;
    const eventType = 'TX_NEW';
    const eventData = { test: 'data' };

    await logTxEventAudit(mysql, txId, eventId, eventType, eventData);

    // Verify no audit log was created
    const [rows] = await mysql.query<AuditRow[]>(
      'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ?',
      [txId]
    );

    expect(rows.length).toBe(0);
  });

  test('should insert audit log when TX_EVENT_AUDIT_ENABLED is true', async () => {
    expect.hasAssertions();

    process.env.TX_EVENT_AUDIT_ENABLED = 'true';

    const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';
    const eventId = 12345;
    const eventType = 'TX_NEW';
    const eventData = {
      stream_id: 'test-stream',
      peer_id: 'test-peer',
      network: 'testnet',
      type: 'FULLNODE_EVENT',
      latest_event_id: 12345,
      event: {
        id: 12345,
        timestamp: 1234567890,
        type: 'NEW_VERTEX_ACCEPTED',
        data: {
          hash: txId,
          timestamp: 1234567890,
          version: 1,
          weight: 18.0,
        },
      },
    };

    await logTxEventAudit(mysql, txId, eventId, eventType, eventData);

    // Verify audit log was created
    const [rows] = await mysql.query<AuditRow[]>(
      'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ?',
      [txId]
    );

    expect(rows.length).toBe(1);
    expect(rows[0].tx_id).toBe(txId);
    expect(rows[0].event_id).toBe(eventId);
    expect(rows[0].event_type).toBe(eventType);

    // Parse and verify the JSON event data
    const storedEventData = JSON.parse(rows[0].event_data);
    expect(storedEventData).toEqual(eventData);
    expect(storedEventData.stream_id).toBe('test-stream');
    expect(storedEventData.event.id).toBe(12345);
  });

  test('should insert multiple audit logs for different event types', async () => {
    expect.hasAssertions();

    process.env.TX_EVENT_AUDIT_ENABLED = 'true';

    const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';

    // Log TX_NEW event
    await logTxEventAudit(mysql, txId, 100, 'TX_NEW', { event: 'new' });

    // Log TX_FIRST_BLOCK event
    await logTxEventAudit(mysql, txId, 200, 'TX_FIRST_BLOCK', { event: 'first_block' });

    // Log TX_VOIDED event
    await logTxEventAudit(mysql, txId, 300, 'TX_VOIDED', { event: 'voided' });

    // Verify all audit logs were created
    const [rows] = await mysql.query<AuditRow[]>(
      'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ? ORDER BY `event_id` ASC',
      [txId]
    );

    expect(rows.length).toBe(3);

    expect(rows[0].event_id).toBe(100);
    expect(rows[0].event_type).toBe('TX_NEW');
    expect(JSON.parse(rows[0].event_data).event).toBe('new');

    expect(rows[1].event_id).toBe(200);
    expect(rows[1].event_type).toBe('TX_FIRST_BLOCK');
    expect(JSON.parse(rows[1].event_data).event).toBe('first_block');

    expect(rows[2].event_id).toBe(300);
    expect(rows[2].event_type).toBe('TX_VOIDED');
    expect(JSON.parse(rows[2].event_data).event).toBe('voided');
  });

  test('should handle complex nested JSON event data', async () => {
    expect.hasAssertions();

    process.env.TX_EVENT_AUDIT_ENABLED = 'true';

    const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';
    const eventId = 12345;
    const eventType = 'TX_NEW';
    const complexEventData = {
      stream_id: 'test-stream',
      peer_id: 'test-peer',
      network: 'testnet',
      nested: {
        deeply: {
          nested: {
            value: 'test',
            array: [1, 2, 3, { key: 'value' }],
            null_value: null,
            bool_value: true,
          },
        },
      },
      event: {
        data: {
          inputs: [
            { tx_id: 'input1', index: 0, spent_output: { value: 100 } },
            { tx_id: 'input2', index: 1, spent_output: { value: 200 } },
          ],
          outputs: [
            { value: 150, address: 'addr1' },
            { value: 150, address: 'addr2' },
          ],
        },
      },
    };

    await logTxEventAudit(mysql, txId, eventId, eventType, complexEventData);

    const [rows] = await mysql.query<AuditRow[]>(
      'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ?',
      [txId]
    );

    expect(rows.length).toBe(1);

    const storedEventData = JSON.parse(rows[0].event_data);
    expect(storedEventData).toEqual(complexEventData);
    expect(storedEventData.nested.deeply.nested.array).toEqual([1, 2, 3, { key: 'value' }]);
    expect(storedEventData.event.data.inputs.length).toBe(2);
    expect(storedEventData.event.data.outputs.length).toBe(2);
  });

  test('should track multiple transactions independently', async () => {
    expect.hasAssertions();

    process.env.TX_EVENT_AUDIT_ENABLED = 'true';

    const txId1 = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';
    const txId2 = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295f';

    await logTxEventAudit(mysql, txId1, 100, 'TX_NEW', { tx: 1 });
    await logTxEventAudit(mysql, txId2, 101, 'TX_NEW', { tx: 2 });
    await logTxEventAudit(mysql, txId1, 102, 'TX_VOIDED', { tx: 1 });

    // Verify tx1 has 2 audit logs
    const [rows1] = await mysql.query<AuditRow[]>(
      'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ? ORDER BY `event_id` ASC',
      [txId1]
    );
    expect(rows1.length).toBe(2);
    expect(rows1[0].event_type).toBe('TX_NEW');
    expect(rows1[1].event_type).toBe('TX_VOIDED');

    // Verify tx2 has 1 audit log
    const [rows2] = await mysql.query<AuditRow[]>(
      'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ?',
      [txId2]
    );
    expect(rows2.length).toBe(1);
    expect(rows2[0].event_type).toBe('TX_NEW');
  });

  test('should have created_at timestamp automatically set', async () => {
    expect.hasAssertions();

    process.env.TX_EVENT_AUDIT_ENABLED = 'true';

    const txId = '00034a15973117852c45520af9e4296c68adb9d39dc99a0342e23cd6686b295e';
    const beforeInsert = new Date();

    await logTxEventAudit(mysql, txId, 12345, 'TX_NEW', { test: 'data' });

    const afterInsert = new Date();

    const [rows] = await mysql.query<AuditRow[]>(
      'SELECT * FROM `tx_event_audit` WHERE `tx_id` = ?',
      [txId]
    );

    expect(rows.length).toBe(1);
    expect(rows[0].created_at).toBeInstanceOf(Date);

    // Verify the timestamp is between before and after
    const createdAt = new Date(rows[0].created_at);
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(beforeInsert.getTime() - 1000); // 1 second tolerance
    expect(createdAt.getTime()).toBeLessThanOrEqual(afterInsert.getTime() + 1000); // 1 second tolerance
  });

  test('should query audit logs by event_id index', async () => {
    expect.hasAssertions();

    process.env.TX_EVENT_AUDIT_ENABLED = 'true';

    const eventId = 12345;

    await logTxEventAudit(mysql, 'tx1', eventId, 'TX_NEW', { tx: 1 });
    await logTxEventAudit(mysql, 'tx2', eventId, 'TX_NEW', { tx: 2 });
    await logTxEventAudit(mysql, 'tx3', 99999, 'TX_NEW', { tx: 3 });

    // Query by event_id
    const [rows] = await mysql.query<AuditRow[]>(
      'SELECT * FROM `tx_event_audit` WHERE `event_id` = ?',
      [eventId]
    );

    expect(rows.length).toBe(2);
    expect(rows[0].event_id).toBe(eventId);
    expect(rows[1].event_id).toBe(eventId);
  });

  test('should query audit logs by event_type index', async () => {
    expect.hasAssertions();

    process.env.TX_EVENT_AUDIT_ENABLED = 'true';

    await logTxEventAudit(mysql, 'tx1', 100, 'TX_VOIDED', { tx: 1 });
    await logTxEventAudit(mysql, 'tx2', 101, 'TX_VOIDED', { tx: 2 });
    await logTxEventAudit(mysql, 'tx3', 102, 'TX_NEW', { tx: 3 });

    // Query by event_type
    const [rows] = await mysql.query<AuditRow[]>(
      'SELECT * FROM `tx_event_audit` WHERE `event_type` = ?',
      ['TX_VOIDED']
    );

    expect(rows.length).toBe(2);
    expect(rows[0].event_type).toBe('TX_VOIDED');
    expect(rows[1].event_type).toBe('TX_VOIDED');
  });
});
