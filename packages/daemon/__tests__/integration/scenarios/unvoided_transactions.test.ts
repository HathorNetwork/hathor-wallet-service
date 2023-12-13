/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { SyncMachine } from '../../../src/machines';
import { interpret } from 'xstate';
import { getLastSyncedEvent, getDbConnection } from '../../../src/db';
import { Connection } from 'mysql2/promise';
import { cleanDatabase, fetchAddressBalances, validateBalances } from '../utils';
import scenarioBalances from './unvoided_transactions.balances';
import { UNVOIDED_SCENARIO_LAST_EVENT } from '../config';

jest.mock('../../../src/config', () => {
  const {
    DB_NAME,
    DB_USER,
    DB_PORT,
    DB_PASS,
    DB_ENDPOINT,
    UNVOIDED_SCENARIO_PORT,
  } = require('../config');

  return {
    __esModule: true,
    default: jest.fn(() => ({
      SERVICE_NAME: 'daemon-test',
      CONSOLE_LEVEL: 'debug',
      TX_CACHE_SIZE: 100,
      BLOCK_REWARD_LOCK: 300,
      FULLNODE_PEER_ID: 'simulator_peer_id',
      STREAM_ID: 'simulator_stream_id',
      NETWORK: 'simulator_network',
      WS_URL: `ws://127.0.0.1:${UNVOIDED_SCENARIO_PORT}/v1a/event_ws`,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    })),
  };
});

// Use a single mysql connection for all tests
let mysql: Connection;
beforeAll(async () => {
  try {
    mysql = await getDbConnection();
  } catch(e) {
    console.error('Failed to establish db connection', e);
    throw e;
  }
});

afterAll(() => {
  // mysql.destroy();
});

beforeEach(async () => {
  await cleanDatabase(mysql);
});

describe('unvoided transaction scenario', () => {
  it('should do a full sync and the balances should match', async () => {
    const machine = interpret(SyncMachine);

    await new Promise<void>((resolve) => {
      machine.onTransition(async (state) => {
        if (state.matches('CONNECTED.idle')) {
          // @ts-ignore
          const lastSyncedEvent = await getLastSyncedEvent(mysql);
          if (lastSyncedEvent?.last_event_id === UNVOIDED_SCENARIO_LAST_EVENT) {
            const addressBalances = await fetchAddressBalances(mysql);
            expect(validateBalances(addressBalances, scenarioBalances));

            machine.stop();

            resolve();
          }
        }
      });

      machine.start();
    });
  });
});
