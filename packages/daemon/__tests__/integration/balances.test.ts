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
import { cleanDatabase, fetchAddressBalances, transitionUntilEvent, validateBalances } from './utils';
import unvoidedScenarioBalances from './scenario_configs/unvoided_transactions.balances';
import reorgScenarioBalances from './scenario_configs/reorg.balances';
import singleChainBlocksAndTransactionsBalances from './scenario_configs/single_chain_blocks_and_transactions.balances';
import invalidMempoolBalances from './scenario_configs/invalid_mempool_transaction.balances';
import emptyScriptBalances from './scenario_configs/empty_script.balances';
import customScriptBalances from './scenario_configs/custom_script.balances';

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
} from './config';

jest.mock('../../src/config', () => {
  return {
    __esModule: true, // This property is needed for mocking a default export
    default: jest.fn(() => ({})),
  };
});

import getConfig from '../../src/config';

// @ts-ignore
getConfig.mockReturnValue({
  NETWORK: 'testnet',
  SERVICE_NAME: 'daemon-test',
  CONSOLE_LEVEL: 'debug',
  TX_CACHE_SIZE: 100,
  BLOCK_REWARD_LOCK: 300,
  FULLNODE_PEER_ID: 'simulator_peer_id',
  STREAM_ID: 'simulator_stream_id',
  FULLNODE_NETWORK: 'simulator_network',
  FULLNODE_HOST: `127.0.0.1:${UNVOIDED_SCENARIO_PORT}`,
  USE_SSL: false,
  DB_ENDPOINT,
  DB_NAME,
  DB_USER,
  DB_PASS,
  DB_PORT,
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

beforeEach(async () => {
  await cleanDatabase(mysql);
});

describe('unvoided transaction scenario', () => {
  beforeAll(() => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
  });

  afterAll(() => {
    jest.resetAllMocks();
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
      FULLNODE_NETWORK: 'simulator_network',
      FULLNODE_HOST: `127.0.0.1:${UNVOIDED_SCENARIO_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-ignore
    await transitionUntilEvent(mysql, machine, UNVOIDED_SCENARIO_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    // @ts-ignore
    expect(validateBalances(addressBalances, unvoidedScenarioBalances));
  });
});

describe('reorg scenario', () => {
  beforeAll(() => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
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
      FULLNODE_NETWORK: 'simulator_network',
      FULLNODE_HOST: `127.0.0.1:${REORG_SCENARIO_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-ignore
    await transitionUntilEvent(mysql, machine, REORG_SCENARIO_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    // @ts-ignore
    expect(validateBalances(addressBalances, reorgScenarioBalances));
  });
});

describe('single chain blocks and transactions scenario', () => {
  beforeAll(() => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
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
      FULLNODE_NETWORK: 'simulator_network',
      FULLNODE_HOST: `127.0.0.1:${SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-ignore
    await transitionUntilEvent(mysql, machine, SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    // @ts-ignore
    expect(validateBalances(addressBalances, singleChainBlocksAndTransactionsBalances));
  });
});

describe('invalid mempool transactions scenario', () => {
  beforeAll(() => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
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
      FULLNODE_NETWORK: 'simulator_network',
      FULLNODE_HOST: `127.0.0.1:${INVALID_MEMPOOL_TRANSACTION_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-ignore
    await transitionUntilEvent(mysql, machine, INVALID_MEMPOOL_TRANSACTION_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    // @ts-ignore
    expect(validateBalances(addressBalances, invalidMempoolBalances));
  });
});

describe('custom script scenario', () => {
  beforeAll(() => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
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
      FULLNODE_NETWORK: 'simulator_network',
      FULLNODE_HOST: `127.0.0.1:${CUSTOM_SCRIPT_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-ignore
    await transitionUntilEvent(mysql, machine, CUSTOM_SCRIPT_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    // @ts-ignore
    expect(validateBalances(addressBalances, customScriptBalances));
  });
});

describe('empty script scenario', () => {
  beforeAll(() => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
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
      FULLNODE_NETWORK: 'simulator_network',
      FULLNODE_HOST: `127.0.0.1:${EMPTY_SCRIPT_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-ignore
    await transitionUntilEvent(mysql, machine, EMPTY_SCRIPT_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    // @ts-ignore
    expect(validateBalances(addressBalances, emptyScriptBalances));
  });
});
