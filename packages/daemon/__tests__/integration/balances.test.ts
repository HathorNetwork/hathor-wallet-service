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
import {
  cleanDatabase,
  fetchAddressBalances,
  transitionUntilEvent,
  validateBalances,
  performVoidingConsistencyChecks,
  validateVoidingConsistency,
} from './utils';
import unvoidedScenarioBalances from './scenario_configs/unvoided_transactions.balances';
import reorgScenarioBalances from './scenario_configs/reorg.balances';
import singleChainBlocksAndTransactionsBalances from './scenario_configs/single_chain_blocks_and_transactions.balances';
import invalidMempoolBalances from './scenario_configs/invalid_mempool_transaction.balances';
import emptyScriptBalances from './scenario_configs/empty_script.balances';
import customScriptBalances from './scenario_configs/custom_script.balances';
import ncEventsBalances from './scenario_configs/nc_events.balances';
import transactionVoidingChainBalances from './scenario_configs/transaction_voiding_chain.balances';

import {
  DB_NAME,
  DB_USER,
  DB_PORT,
  DB_PASS,
  DB_ENDPOINT,
  INVALID_MEMPOOL_TRANSACTION_PORT,
  UNVOIDED_SCENARIO_PORT,
  UNVOIDED_SCENARIO_LAST_EVENT,
  REORG_SCENARIO_PORT,
  REORG_SCENARIO_LAST_EVENT,
  SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS_PORT,
  SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS_LAST_EVENT,
  INVALID_MEMPOOL_TRANSACTION_LAST_EVENT,
  CUSTOM_SCRIPT_PORT,
  CUSTOM_SCRIPT_LAST_EVENT,
  EMPTY_SCRIPT_PORT,
  EMPTY_SCRIPT_LAST_EVENT,
  NC_EVENTS_PORT,
  NC_EVENTS_LAST_EVENT,
  TRANSACTION_VOIDING_CHAIN_PORT,
  TRANSACTION_VOIDING_CHAIN_LAST_EVENT,
} from './config';

jest.mock('../../src/config', () => {
  return {
    __esModule: true, // This property is needed for mocking a default export
    default: jest.fn(() => ({})),
  };
});

import getConfig from '../../src/config';

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
  FULLNODE_HOST: `127.0.0.1:${UNVOIDED_SCENARIO_PORT}`,
  USE_SSL: false,
  DB_ENDPOINT,
  DB_NAME,
  DB_USER,
  DB_PASS,
  DB_PORT,
});

let mysql: Connection;

beforeAll(async () => {
  mysql = await getDbConnection();
  await cleanDatabase(mysql);
});

afterAll(async () => {
  jest.resetAllMocks();
  if (mysql && 'release' in mysql) {
    // @ts-expect-error - pooled connection has release method
    await mysql.release();
  }
});

describe('unvoided transaction scenario', () => {
  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
  });

  it('should do a full sync and the balances should match', async () => {
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
      FULLNODE_HOST: `127.0.0.1:${UNVOIDED_SCENARIO_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, UNVOIDED_SCENARIO_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    await validateBalances(addressBalances, unvoidedScenarioBalances);
  });
});

describe('reorg scenario', () => {
  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    await cleanDatabase(mysql);
  });

  it('should do a full sync and the balances should match', async () => {
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
      FULLNODE_HOST: `127.0.0.1:${REORG_SCENARIO_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, REORG_SCENARIO_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    await validateBalances(addressBalances, reorgScenarioBalances);
  });
});

describe('single chain blocks and transactions scenario', () => {
  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    await cleanDatabase(mysql);
  });

  it('should do a full sync and the balances should match', async () => {
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
      FULLNODE_HOST: `127.0.0.1:${SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    await validateBalances(addressBalances, singleChainBlocksAndTransactionsBalances);
  });
});

describe('invalid mempool transactions scenario', () => {
  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    await cleanDatabase(mysql);
  });

  it('should do a full sync and the balances should match', async () => {
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
      FULLNODE_HOST: `127.0.0.1:${INVALID_MEMPOOL_TRANSACTION_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, INVALID_MEMPOOL_TRANSACTION_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    await validateBalances(addressBalances, invalidMempoolBalances);
  });
});

describe('custom script scenario', () => {
  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    await cleanDatabase(mysql);
  });

  it('should do a full sync and the balances should match', async () => {
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
      FULLNODE_HOST: `127.0.0.1:${CUSTOM_SCRIPT_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, CUSTOM_SCRIPT_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    await validateBalances(addressBalances, customScriptBalances);
  });
});

describe('empty script scenario', () => {
  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    await cleanDatabase(mysql);
  });

  it('should do a full sync and the balances should match', async () => {
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
      FULLNODE_HOST: `127.0.0.1:${EMPTY_SCRIPT_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, EMPTY_SCRIPT_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);

    await validateBalances(addressBalances, emptyScriptBalances);
  });
});

describe('nc events scenario', () => {
  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    await cleanDatabase(mysql);
  });

  it('should do a full sync and the balances should match', async () => {
    // @ts-ignore
    getConfig.mockReturnValue({
      NETWORK: 'testnet',
      SERVICE_NAME: 'daemon-test',
      CONSOLE_LEVEL: 'debug',
      TX_CACHE_SIZE: 100,
      BLOCK_REWARD_LOCK: 300,
      FULLNODE_PEER_ID: 'simulator_peer_id',
      STREAM_ID: 'simulator_stream_id',
      FULLNODE_NETWORK: 'unittests',
      FULLNODE_HOST: `127.0.0.1:${NC_EVENTS_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-ignore
    await transitionUntilEvent(mysql, machine, NC_EVENTS_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);

    await validateBalances(addressBalances, ncEventsBalances);
  });
});

describe('transaction voiding chain scenario', () => {
  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    await cleanDatabase(mysql);
  });

  it('should do a full sync and the balances should match after voiding chain', async () => {
    // @ts-ignore
    getConfig.mockReturnValue({
      NETWORK: 'testnet',
      SERVICE_NAME: 'daemon-test',
      CONSOLE_LEVEL: 'debug',
      TX_CACHE_SIZE: 100,
      BLOCK_REWARD_LOCK: 300,
      FULLNODE_PEER_ID: 'simulator_peer_id',
      STREAM_ID: 'simulator_stream_id',
      FULLNODE_NETWORK: 'unittests',
      FULLNODE_HOST: `127.0.0.1:${TRANSACTION_VOIDING_CHAIN_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-ignore
    await transitionUntilEvent(mysql, machine, TRANSACTION_VOIDING_CHAIN_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);

    await validateBalances(addressBalances, transactionVoidingChainBalances);

    // Validate transaction voiding consistency
    const voidingChecks = await performVoidingConsistencyChecks(mysql, {
      transactions: [
        { txId: '404eeba6f3658028722e665684c42a0c28c3a44b190426971e012c5030bf1903', expectedVoided: false }, // tx1
        { txId: '4412a1f718b51c054193cc0df2d1dd9d16e82684be17760d7169aa6fb22d5ea2', expectedVoided: false }, // tx2
        { txId: '06b20fd4258ae965137203d4e1fd7df7b69e775e5d3f4a4568d1161343b91f02', expectedVoided: true },  // spending_tx (voided)
        { txId: 'ada5e728ffd680238306b510899629099d6bbb58a8811b042c249a236f9640cc', expectedVoided: false }, // voiding_tx
      ],
      utxos: [
        // Spending transaction (voided) UTXOs should be marked as voided
        { txId: '06b20fd4258ae965137203d4e1fd7df7b69e775e5d3f4a4568d1161343b91f02', index: 0, expectedValue: 5900, expectedVoided: true, expectedSpentBy: null },
        { txId: '06b20fd4258ae965137203d4e1fd7df7b69e775e5d3f4a4568d1161343b91f02', index: 1, expectedValue: 500, expectedVoided: true, expectedSpentBy: null },

        // Voiding transaction (valid) UTXOs should not be voided
        { txId: 'ada5e728ffd680238306b510899629099d6bbb58a8811b042c249a236f9640cc', index: 0, expectedValue: 5900, expectedVoided: false, expectedSpentBy: null },
        { txId: 'ada5e728ffd680238306b510899629099d6bbb58a8811b042c249a236f9640cc', index: 1, expectedValue: 500, expectedVoided: false, expectedSpentBy: null },
      ],
    });

    // Validate consistency
    validateVoidingConsistency(voidingChecks);
  }, 30000); // 30 second timeout for transaction voiding chain test
});
