/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as Services from '../../src/services';
import { SyncMachine } from '../../src/machines';
import { interpret } from 'xstate';
import { getDbConnection } from '../../src/db';
import { Connection } from 'mysql2/promise';
import { cleanDatabase, transitionUntilEvent } from './utils';

import {
  DB_NAME,
  DB_USER,
  DB_PORT,
  DB_PASS,
  DB_ENDPOINT,
} from './config';

jest.mock('../../src/config', () => {
  return {
    __esModule: true,
    default: jest.fn(() => ({})),
  };
});

jest.mock('../../src/utils/aws', () => {
  return {
    sendRealtimeTx: jest.fn(),
    invokeOnTxPushNotificationRequestedLambda: jest.fn(),
  };
});

import getConfig from '../../src/config';

const TOKEN_CREATED_HYBRID_WITH_REORG_PORT = 8094;
const TOKEN_CREATED_HYBRID_WITH_REORG_LAST_EVENT = 43;

// @ts-expect-error
getConfig.mockReturnValue({
  NETWORK: 'testnet',
  SERVICE_NAME: 'daemon-test',
  CONSOLE_LEVEL: 'debug',
  TX_CACHE_SIZE: 100,
  BLOCK_REWARD_LOCK: 300,
  FULLNODE_PEER_ID: 'simulator_peer_id',
  STREAM_ID: 'simulator_stream_id',
  FULLNODE_NETWORK: 'unittests',
  FULLNODE_HOST: `127.0.0.1:${TOKEN_CREATED_HYBRID_WITH_REORG_PORT}`,
  USE_SSL: false,
  DB_ENDPOINT,
  DB_NAME,
  DB_USER,
  DB_PASS,
  DB_PORT,
  ACK_TIMEOUT_MS: 20000,
});

let mysql: Connection;

beforeAll(async () => {
  mysql = await getDbConnection();
  await cleanDatabase(mysql);
});

beforeEach(async () => {
  await cleanDatabase(mysql);
});

afterAll(async () => {
  jest.resetAllMocks();
  if (mysql && 'release' in mysql) {
    // @ts-expect-error - pooled connection has release method
    await mysql.release();
  }
});

// Mock checkForMissedEvents since HTTP API is not available in test simulators
jest.spyOn(Services, 'checkForMissedEvents').mockImplementation(async () => ({
  hasNewEvents: false,
  events: [],
}));

/**
 * Integration test for TOKEN_CREATED with REORG scenario.
 *
 * This test validates the edge case where a single transaction creates tokens in
 * TWO different ways:
 * 1. Traditional CREATE_TOKEN_TX: Token created immediately when transaction hits mempool
 * 2. Nano contract syscall: Token created when nano contract executes successfully
 *
 * Test Flow:
 * 1. Hybrid transaction arrives with both CREATE_TOKEN_TX and nano headers
 * 2. TOKEN_CREATED event #1: Traditional token "HYB" with nc_exec_info: null
 * 3. Transaction gets confirmed in a block
 * 4. Nano executes successfully (nc_execution: SUCCESS)
 * 5. TOKEN_CREATED event #2: Nano-created token "NCX" with nc_exec_info: {nc_tx, nc_block}
 * 6. REORG happens - different branch wins
 * 7. During reorg: nc_execution stays at SUCCESS (transaction remains in winning branch)
 * 8. TOKEN_CREATED event for NCX is replayed during reorg
 * 9. REORG finishes
 *
 * Expected Behavior:
 * - HYB token (traditional) REMAINS in database (persists through reorg)
 * - NCX token (nano-created) REMAINS in database (nano execution stays valid)
 * - Both tokens exist at the end
 * - HYB maps to itself (token_id = tx_id for CREATE_TOKEN_TX)
 * - NCX maps to the nano transaction that created it
 *
 * This validates that:
 * - Traditional CREATE_TOKEN_TX tokens persist through reorg
 * - Nano-created tokens persist when nano execution remains valid during reorg
 * - TOKEN_CREATED events are properly replayed during reorg
 * - Token creation mappings are correct for both token types
 */
describe('token created with reorg scenario', () => {
  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    await cleanDatabase(mysql);
  });

  it('should keep both traditional and nano-created tokens after reorg', async () => {
    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, TOKEN_CREATED_HYBRID_WITH_REORG_LAST_EVENT);

    // Query all tokens from the database
    const [allTokens] = await mysql.query<any[]>('SELECT * FROM `token`');

    // Should have exactly 2 tokens: HYB (traditional) and NCX (nano-created)
    expect(allTokens.length).toBe(2);

    // Find the HYB token (traditional CREATE_TOKEN_TX)
    const hybToken = allTokens.find(t => t.symbol === 'HYB');
    expect(hybToken).toBeDefined();
    expect(hybToken?.name).toBe('HYB');
    expect(hybToken?.symbol).toBe('HYB');

    // Find the NCX token (nano-created)
    const ncxToken = allTokens.find(t => t.symbol === 'NCX');
    expect(ncxToken).toBeDefined();
    expect(ncxToken?.name).toBe('NC Extra Token');
    expect(ncxToken?.symbol).toBe('NCX');

    // Verify token creation mappings
    // HYB is a CREATE_TOKEN_TX token, so token_id = tx_id
    // The HYB token itself IS the transaction
    expect(hybToken!.id).toBe('0a8053b70fb4fd94028fc922e5750ff9e209c3c7563b896e67b56c946883c0d8');

    const [hybMappings] = await mysql.query<any[]>(
      'SELECT * FROM `token_creation` WHERE token_id = ?',
      [hybToken!.id]
    );
    expect(hybMappings.length).toBe(1);
    expect(hybMappings[0].tx_id).toBe('0a8053b70fb4fd94028fc922e5750ff9e209c3c7563b896e67b56c946883c0d8');

    // NCX is nano-created, so it maps to the nano transaction (the hybrid tx)
    const [ncxMappings] = await mysql.query<any[]>(
      'SELECT * FROM `token_creation` WHERE token_id = ?',
      [ncxToken!.id]
    );
    expect(ncxMappings.length).toBe(1);
    // The NCX token maps to the nano transaction that created it
    expect(ncxMappings[0].tx_id).toBe('0ae5a22d37bf93f06ffd66fc9a49c562f32132ea5790e19d362fcfae4e48d628');
  }, 30000);

  it('should verify TOKEN_CREATED events for both traditional and nano-created tokens', async () => {
    const machine = interpret(SyncMachine);
    const receivedEvents: any[] = [];

    // Capture all events during sync
    machine.onTransition((state) => {
      if (state.context.event) {
        receivedEvents.push(state.context.event);
      }
    });

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, TOKEN_CREATED_HYBRID_WITH_REORG_LAST_EVENT);

    // Filter for TOKEN_CREATED events
    const tokenCreatedEvents = receivedEvents.filter(
      (e) => e.event?.type === 'TOKEN_CREATED'
    );

    // Find the HYB token event (traditional CREATE_TOKEN_TX)
    const hybTokenEvent = tokenCreatedEvents.find(
      (e) => e.event?.data?.token_symbol === 'HYB'
    );

    // Verify HYB token event exists
    expect(hybTokenEvent).toBeDefined();
    expect(hybTokenEvent.event.data.token_name).toBe('HYB');
    expect(hybTokenEvent.event.data.token_symbol).toBe('HYB');
    expect(hybTokenEvent.event.data.nc_exec_info).toBeNull(); // Traditional token has no nano info
    expect(hybTokenEvent.event.data.initial_amount).toBe(500);

    // Find the NCX token event (nano-created)
    const ncxTokenEvents = tokenCreatedEvents.filter(
      (e) => e.event?.data?.token_symbol === 'NCX'
    );

    // NCX should appear at least twice: once before reorg, once during reorg replay
    // (May appear more times if there are multiple test runs captured)
    expect(ncxTokenEvents.length).toBeGreaterThanOrEqual(2);

    // Find the event before reorg (group_id is null)
    const ncxBeforeReorg = ncxTokenEvents.find(e => e.event.group_id === null);
    expect(ncxBeforeReorg).toBeDefined();
    expect(ncxBeforeReorg.event.data.token_name).toBe('NC Extra Token');
    expect(ncxBeforeReorg.event.data.token_symbol).toBe('NCX');
    expect(ncxBeforeReorg.event.data.nc_exec_info).not.toBeNull();
    expect(ncxBeforeReorg.event.data.nc_exec_info.nc_tx).toBe('0ae5a22d37bf93f06ffd66fc9a49c562f32132ea5790e19d362fcfae4e48d628');
    expect(ncxBeforeReorg.event.data.nc_exec_info.nc_block).toBeDefined();
    expect(ncxBeforeReorg.event.data.initial_amount).toBe(777);

    // Find the event during reorg (group_id is 0)
    const ncxDuringReorg = ncxTokenEvents.find(e => e.event.group_id === 0);
    expect(ncxDuringReorg).toBeDefined();
    expect(ncxDuringReorg.event.data.token_name).toBe('NC Extra Token');
    expect(ncxDuringReorg.event.data.initial_amount).toBe(777);
  }, 30000);

  it('should verify nano execution remains successful after reorg', async () => {
    const machine = interpret(SyncMachine);
    const receivedEvents: any[] = [];

    // Capture all events during sync
    machine.onTransition((state) => {
      if (state.context.event) {
        receivedEvents.push(state.context.event);
      }
    });

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, TOKEN_CREATED_HYBRID_WITH_REORG_LAST_EVENT);

    // Filter for VERTEX_METADATA_CHANGED events for the nano transaction
    const nanoTxHash = '0ae5a22d37bf93f06ffd66fc9a49c562f32132ea5790e19d362fcfae4e48d628';
    const metadataChangedEvents = receivedEvents.filter(
      (e) => e.event?.type === 'VERTEX_METADATA_CHANGED' &&
             e.event?.data?.hash === nanoTxHash
    );

    // Find metadata changes with nc_execution: success
    const successEvents = metadataChangedEvents.filter(
      (e) => e.event?.data?.metadata?.nc_execution === 'success'
    );

    // The nano execution should remain at SUCCESS even after reorg
    // because the transaction is included in the winning branch
    expect(successEvents.length).toBeGreaterThan(0);

    // Verify the last metadata event for this tx still shows success
    const lastEvent = metadataChangedEvents[metadataChangedEvents.length - 1];
    expect(lastEvent.event.data.metadata.nc_execution).toBe('success');
    expect(lastEvent.event.data.metadata.first_block).toBeDefined();
  }, 30000);

  it('should verify nano execution stays successful during reorg', async () => {
    const machine = interpret(SyncMachine);
    const receivedEvents: any[] = [];

    // Capture all events during sync
    machine.onTransition((state) => {
      if (state.context.event) {
        receivedEvents.push(state.context.event);
      }
    });

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, TOKEN_CREATED_HYBRID_WITH_REORG_LAST_EVENT);

    // Filter for VERTEX_METADATA_CHANGED events for the nano transaction
    const nanoTxHash = '0ae5a22d37bf93f06ffd66fc9a49c562f32132ea5790e19d362fcfae4e48d628';
    const metadataChangedEvents = receivedEvents.filter(
      (e) => e.event?.type === 'VERTEX_METADATA_CHANGED' &&
             e.event?.data?.hash === nanoTxHash
    );

    // Should have received metadata change events for the nano transaction
    expect(metadataChangedEvents.length).toBeGreaterThan(0);

    // Find events within the reorg group (group_id: 0)
    const reorgGroupEvents = metadataChangedEvents.filter(
      (e) => e.event?.group_id === 0
    );

    // If there are reorg group events for this tx, verify they show success
    if (reorgGroupEvents.length > 0) {
      const successExecEvent = reorgGroupEvents.find(
        (e) => e.event?.data?.metadata?.nc_execution === 'success' &&
               e.event?.data?.metadata?.first_block !== null
      );

      // Verify the nano execution stays at SUCCESS during reorg
      expect(successExecEvent).toBeDefined();

      // There should be NO event where nc_execution goes to null for this specific tx during reorg
      const nullExecEvent = reorgGroupEvents.find(
        (e) => e.event?.data?.metadata?.nc_execution === null
      );
      expect(nullExecEvent).toBeUndefined();
    }
  }, 30000);

  it('should verify REORG events are properly detected', async () => {
    const machine = interpret(SyncMachine);
    const receivedEvents: any[] = [];

    // Capture all events during sync
    machine.onTransition((state) => {
      if (state.context.event) {
        receivedEvents.push(state.context.event);
      }
    });

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, TOKEN_CREATED_HYBRID_WITH_REORG_LAST_EVENT);

    // Find REORG_STARTED and REORG_FINISHED events
    const reorgStarted = receivedEvents.find(
      (e) => e.event?.type === 'REORG_STARTED'
    );
    const reorgFinished = receivedEvents.find(
      (e) => e.event?.type === 'REORG_FINISHED'
    );

    // Verify both events exist
    expect(reorgStarted).toBeDefined();
    expect(reorgFinished).toBeDefined();

    // Verify REORG_STARTED has group_id (0 in this case)
    expect(reorgStarted.event.group_id).toBe(0);

    // Verify REORG_STARTED has expected data
    expect(reorgStarted.event.data.reorg_size).toBe(1);
    expect(reorgStarted.event.data.previous_best_block).toBe('f72b5b3f78b8b1bdeea102939a8a43cb848357dbda9e55deaa5804fdbd1a6253');
    expect(reorgStarted.event.data.new_best_block).toBe('f1478b060df7a638b56ac68700f79c575b7e7821311396242672046b8ca7376c');
    expect(reorgStarted.event.data.common_block).toBe('9fc4e8ada11df2c34700f6036d1acd2822b6ce6212af5cd1f5923c9cb7e549a4');
  }, 30000);
});
