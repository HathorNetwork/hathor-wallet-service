/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as Services from '../../src/services';
import { SyncMachine } from '../../src/machines';
import { interpret } from 'xstate';
import { getDbConnection, getTokenInformation } from '../../src/db';
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
const TOKEN_CREATED_HYBRID_WITH_REORG_LAST_EVENT = 36;

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
 * NOTE: Despite the scenario name "TOKEN_CREATED_HYBRID_WITH_REORG", this is actually
 * a PURE NANO CONTRACT scenario, not a hybrid transaction.
 *
 * This test validates that nano-created tokens are properly deleted when a reorg
 * invalidates the nano contract execution.
 *
 * Test Flow:
 * 1. Nano contract transaction (985aa68e...) arrives with nano headers
 * 2. Transaction gets confirmed in block (9a15d3ee...)
 * 3. Nano executes successfully (nc_execution: SUCCESS)
 * 4. TOKEN_CREATED event: Nano-created token (NCX) with nc_exec_info: {nc_tx, nc_block}
 * 5. REORG happens - different branch wins
 * 6. The reorg does NOT invalidate the nano execution (it stays in the winning branch)
 *
 * Expected Behavior:
 * - NCX token REMAINS in database (nano execution is still valid on the winning branch)
 *
 * This validates that:
 * - Nano-created tokens are kept when they remain valid after reorg
 * - Only tokens from invalidated nano executions are deleted
 */
describe('token created with reorg scenario', () => {
  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    await cleanDatabase(mysql);
  });

  it('should keep nano-created token when reorg does not invalidate nano execution', async () => {
    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, TOKEN_CREATED_HYBRID_WITH_REORG_LAST_EVENT);

    // Query all tokens from the database
    const [allTokens] = await mysql.query<any[]>('SELECT * FROM `token`');

    // Find the NC Extra Token
    const ncxToken = allTokens.find(t => t.name === 'NC Extra Token');

    // Verify NCX token (nano-created) still exists
    expect(ncxToken).toBeDefined();
    expect(ncxToken?.name).toBe('NC Extra Token');
    expect(ncxToken?.symbol).toBe('NCX');

    // Verify token creation mappings for the NC Extra Token
    const [tokenCreationMappings] = await mysql.query<any[]>(
      'SELECT * FROM `token_creation` WHERE token_id = ?',
      [ncxToken!.id]
    );

    // Should have the nano-created token mapping
    expect(tokenCreationMappings.length).toBe(1);
    expect(tokenCreationMappings[0].token_id).toBe(ncxToken!.id);
  }, 30000);

  it('should verify TOKEN_CREATED event was received for nano-created token', async () => {
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

    // Find the NCX token event specifically
    const ncxTokenEvent = tokenCreatedEvents.find(
      (e) => e.event?.data?.token_symbol === 'NCX'
    );

    // Verify NCX token event (nano-created) exists
    expect(ncxTokenEvent).toBeDefined();
    expect(ncxTokenEvent.event.data.token_name).toBe('NC Extra Token');
    expect(ncxTokenEvent.event.data.token_symbol).toBe('NCX');
    expect(ncxTokenEvent.event.data.nc_exec_info).not.toBeNull();
    expect(ncxTokenEvent.event.data.nc_exec_info.nc_tx).toBe('985aa68e0b0595a968f56d43fdde593a077992ef3e81f9a452ec90664fa6342c');
    expect(ncxTokenEvent.event.data.nc_exec_info.nc_block).toBe('9a15d3eeb6b2f383e1c14d30715268b28f8e840331e5a88d04fa5e61a54bdf5d');
    expect(ncxTokenEvent.event.data.initial_amount).toBe(777);
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
    const nanoTxHash = '985aa68e0b0595a968f56d43fdde593a077992ef3e81f9a452ec90664fa6342c';
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
    expect(lastEvent.event.data.metadata.first_block).toBe('9a15d3eeb6b2f383e1c14d30715268b28f8e840331e5a88d04fa5e61a54bdf5d');
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
    expect(reorgStarted.event.data.previous_best_block).toBe('0161ccc829a9c8b4121823f0ff2edc305d13c9e93f3ff446bd384598e45c9f57');
    expect(reorgStarted.event.data.new_best_block).toBe('9a15d3eeb6b2f383e1c14d30715268b28f8e840331e5a88d04fa5e61a54bdf5d');
    expect(reorgStarted.event.data.common_block).toBe('10fff6c4ce172c7bf43a992bd99738dba984866cca9cb125dca6620dfb526034');
  }, 30000);
});
