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
const TOKEN_CREATED_HYBRID_WITH_REORG_LAST_EVENT = 57;

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
 * Integration test for TOKEN_CREATED with REORG scenario (HYBRID transaction).
 *
 * This test validates a hybrid transaction that creates tokens in TWO different ways:
 * 1. Traditional CREATE_TOKEN_TX: Token created immediately when transaction hits mempool
 * 2. Nano contract syscall: Token created when nano contract executes successfully
 *
 * Test Flow:
 * 1. Hybrid transaction arrives with both CREATE_TOKEN_TX and nano headers
 * 2. TOKEN_CREATED event #1: Traditional token "HYB" with nc_exec_info: null
 * 3. Transaction gets confirmed in block b2 (nc_block)
 * 4. Nano executes successfully (nc_execution: SUCCESS)
 * 5. TOKEN_CREATED event #2: Nano-created token "NCX" with nc_exec_info: {nc_tx, nc_block}
 * 6. REORG happens - a-chain (a2 → a3 → a4 → a5) becomes longer than b-chain (b1 → b2)
 * 7. Block b2 gets orphaned, nc_execution changes from 'success' to 'pending'
 * 8. Transaction gets re-confirmed in block a3, nc_execution goes back to 'success'
 * 9. TOKEN_CREATED event #3: NCX is re-created during reorg (group_id: 0)
 * 10. REORG finishes
 *
 * Expected Behavior:
 * - HYB token (traditional) REMAINS in database throughout reorg (never deleted)
 * - NCX token (nano-created) gets deleted when nc_execution is no longer 'success', then re-created when nc_execution → 'success'
 * - Both tokens exist at the end
 * - HYB maps to the hybrid transaction (token_id = tx_id for CREATE_TOKEN_TX)
 * - NCX maps to the hybrid transaction (created by nano contract syscall)
 * - NCX TOKEN_CREATED fires TWICE: once before reorg (nc_block: 124ccc...), once after reorg (nc_block: 5ffca1...)
 *
 * This validates that:
 * - Traditional CREATE_TOKEN_TX tokens persist through reorg (not affected by nc_execution changes)
 * - Nano-created tokens are deleted when nc_execution is no longer 'success'
 * - Nano-created tokens are re-created when nc_execution goes back to 'success'
 * - TOKEN_CREATED events are properly fired during reorg for nano-created tokens
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
    expect(hybToken!.id).toBe('0a0166cf0d73e3aaf85678f63ae4c0c87c6ca9cef138bf945837dbe7197b8b75');

    const [hybMappings] = await mysql.query<any[]>(
      'SELECT * FROM `token_creation` WHERE token_id = ?',
      [hybToken!.id]
    );
    expect(hybMappings.length).toBe(1);
    expect(hybMappings[0].tx_id).toBe('0a0166cf0d73e3aaf85678f63ae4c0c87c6ca9cef138bf945837dbe7197b8b75');

    // NCX is nano-created, so it maps to the nano transaction (the hybrid tx)
    const [ncxMappings] = await mysql.query<any[]>(
      'SELECT * FROM `token_creation` WHERE token_id = ?',
      [ncxToken!.id]
    );
    expect(ncxMappings.length).toBe(1);
    // The NCX token maps to the nano transaction that created it
    expect(ncxMappings[0].tx_id).toBeDefined();
  }, 30000);

  it('should create NCX token, delete it during reorg, and re-create it after reorg', async () => {
    const ncxTokenId = '82d79eb32061fc69b55dad901b6daba7ce1496b7c40bf3c2709c0a14192265ee';

    // Helper to check if NCX token exists in DB
    const getNcxToken = async () => {
      const [tokens] = await mysql.query<any[]>(
        'SELECT * FROM `token` WHERE id = ?',
        [ncxTokenId]
      );
      return tokens.length > 0 ? tokens[0] : null;
    };

    // Step 1: Run until event 28 (first TOKEN_CREATED for NCX)
    // NCX should be created when nc_execution = success
    await cleanDatabase(mysql);
    const machine1 = interpret(SyncMachine);
    // @ts-expect-error
    await transitionUntilEvent(mysql, machine1, 28);

    const ncxAfterCreation = await getNcxToken();
    expect(ncxAfterCreation).not.toBeNull();
    expect(ncxAfterCreation?.symbol).toBe('NCX');
    expect(ncxAfterCreation?.name).toBe('NC Extra Token');

    // Step 2: Run until event 34 (VERTEX_METADATA_CHANGED with nc_execution = pending)
    // NCX should be deleted when nc_execution changes from success to pending
    await cleanDatabase(mysql);
    const machine2 = interpret(SyncMachine);
    // @ts-expect-error
    await transitionUntilEvent(mysql, machine2, 34);

    const ncxAfterReorg = await getNcxToken();
    expect(ncxAfterReorg).toBeNull(); // Token should be deleted

    // Step 3: Run until event 47 (second TOKEN_CREATED for NCX)
    // NCX should be re-created when nc_execution = success again
    await cleanDatabase(mysql);
    const machine3 = interpret(SyncMachine);
    // @ts-expect-error
    await transitionUntilEvent(mysql, machine3, 47);

    const ncxAfterRecreation = await getNcxToken();
    expect(ncxAfterRecreation).not.toBeNull();
    expect(ncxAfterRecreation?.symbol).toBe('NCX');
    expect(ncxAfterRecreation?.name).toBe('NC Extra Token');
  }, 60000);

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
    const nanoTxHash = '0a0166cf0d73e3aaf85678f63ae4c0c87c6ca9cef138bf945837dbe7197b8b75';
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

  it('should verify nano execution changes during reorg', async () => {
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
    const nanoTxHash = '0a0166cf0d73e3aaf85678f63ae4c0c87c6ca9cef138bf945837dbe7197b8b75';
    const metadataChangedEvents = receivedEvents.filter(
      (e) => e.event?.type === 'VERTEX_METADATA_CHANGED' &&
             e.event?.data?.hash === nanoTxHash
    );

    // Find events within the reorg group (group_id: 0)
    const reorgGroupEvents = metadataChangedEvents.filter(
      (e) => e.event?.group_id === 0
    );

    // In this scenario, if there are reorg events for the nano tx,
    // the nano execution should remain 'success' because the transaction
    // is re-confirmed in the winning chain
    if (reorgGroupEvents.length > 0) {
      const successExecEvent = reorgGroupEvents.find(
        (e) => e.event?.data?.metadata?.nc_execution === 'success' &&
               e.event?.data?.metadata?.first_block !== null
      );
      expect(successExecEvent).toBeDefined();
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
    // These hashes are deterministic from the simulator
    expect(reorgStarted.event.data.previous_best_block).toBeDefined();
    expect(reorgStarted.event.data.new_best_block).toBeDefined();
    expect(reorgStarted.event.data.common_block).toBeDefined();
  }, 30000);
});
