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
  fetchWalletBalances,
  transitionUntilEvent,
  validateBalances,
  validateWalletBalances,
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
import voidedTokenAuthorityBalances from './scenario_configs/voided_token_authority.balances';
import singleVoidedCreateTokenTransactionBalances from './scenario_configs/single_voided_create_token_transaction.balances';

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
  VOIDED_TOKEN_AUTHORITY_PORT,
  VOIDED_TOKEN_AUTHORITY_LAST_EVENT,
  SINGLE_VOIDED_CREATE_TOKEN_TRANSACTION_PORT,
  SINGLE_VOIDED_CREATE_TOKEN_TRANSACTION_LAST_EVENT,
} from './config';

jest.mock('../../src/config', () => {
  return {
    __esModule: true, // This property is needed for mocking a default export
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

describe('unvoided transaction scenario', () => {
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
    await expect(validateBalances(addressBalances, unvoidedScenarioBalances.addressBalances)).resolves.not.toThrow();
  }, 30000);
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
    await expect(validateBalances(addressBalances, reorgScenarioBalances.addressBalances)).resolves.not.toThrow();
  }, 30000);
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
    await expect(validateBalances(addressBalances, singleChainBlocksAndTransactionsBalances.addressBalances)).resolves.not.toThrow();
  }, 30000);
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
    await expect(validateBalances(addressBalances, invalidMempoolBalances.addressBalances)).resolves.not.toThrow();
  }, 30000);
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
    await expect(validateBalances(addressBalances, customScriptBalances.addressBalances)).resolves.not.toThrow();
  }, 30000);
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

    await expect(validateBalances(addressBalances, emptyScriptBalances.addressBalances)).resolves.not.toThrow();
  }, 30000);
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

    await expect(validateBalances(addressBalances, ncEventsBalances.addressBalances)).resolves.not.toThrow();
  }, 30000);
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

    await expect(validateBalances(addressBalances, transactionVoidingChainBalances.addressBalances)).resolves.not.toThrow();

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

describe('voided token authority scenario', () => {

  const initializeWallet = async (mysql: Connection): Promise<void> => {
    // Insert wallet records
    const walletSQL = `
      INSERT INTO wallet (
          id,
          xpubkey,
          status,
          max_gap,
          created_at,
          ready_at,
          retry_count,
          auth_xpubkey,
          last_used_address_index
      ) VALUES
      (
          'deafbeef',
          'xpub6F81iNtH5HVknoJ65cK2XAGA5F3okdJK7WHwVAAPZnSir2sfwbhvB9ffNKQ4wLor75QxPe9p12tqt8xUZSG8i8AAPMpkFho7fbWkBJQ5s1x',
          'ready',
          20,
          UNIX_TIMESTAMP(),
          UNIX_TIMESTAMP(),
          0,
          'xpub6F81iNtH5HVknoJ65cK2XAGA5F3okdJK7WHwVAAPZnSir2sfwbhvB9ffNKQ4wLor75QxPe9p12tqt8xUZSG8i8AAPMpkFho7fbWkBJQ5s1x',
          -1
      ),
      (
          'cafecafe',
          'xpub6F81iNtH5HVknoJ65cK2XAGA5F3okdJK7WHwVAAPZnSir2sfwbhvB9ffNKQ4wLor75QxPe9p12tqt8xUZSG8i8AAPMpkFho7fbWkBJQ5s1x',
          'ready',
          20,
          UNIX_TIMESTAMP(),
          UNIX_TIMESTAMP(),
          0,
          'xpub6F81iNtH5HVknoJ65cK2XAGA5F3okdJK7WHwVAAPZnSir2sfwbhvB9ffNKQ4wLor75QxPe9p12tqt8xUZSG8i8AAPMpkFho7fbWkBJQ5s1x',
          -1
      )`;

    // Insert address records - all addresses with the same wallet_id
    const addressSQL = `
      INSERT INTO address (address, \`index\`, wallet_id, transactions, seqnum) VALUES
      ('HFtz2f59Lms4p3Jfgtsr73s97MbJHsRENh', 0, 'deafbeef', 0, 0),
      ('HJQbEERnD5Ak3f2dsi8zAmsZrCWTT8FZns', 0, 'cafecafe', 1, 0),
      ('HRQe4CXj8AZXzSmuNztU8iQR74QTQMbnTs', 1, 'deafbeef', 21, 0),
      ('HRXVDmLVdq8pgok1BCUKpiFWdAVAy4a5AJ', 2, 'deafbeef', 1, 0)`;

    await mysql.query(walletSQL);
    await mysql.query(addressSQL);
  };

  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    await cleanDatabase(mysql);
  });

  afterAll(async () => {
    // Clean up wallet data after this test to prevent affecting other tests
    // await cleanDatabase(mysql);
  });

  it('should do a full sync and the balances should match after voiding token authority', async () => {
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
      FULLNODE_HOST: `127.0.0.1:${VOIDED_TOKEN_AUTHORITY_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    // Initialize wallet before processing events
    await initializeWallet(mysql);

    const machine = interpret(SyncMachine);

    // @ts-ignore
    await transitionUntilEvent(mysql, machine, VOIDED_TOKEN_AUTHORITY_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    const walletBalances = await fetchWalletBalances(mysql);

    await expect(validateBalances(addressBalances, voidedTokenAuthorityBalances.addressBalances)).resolves.not.toThrow();

    // Validate wallet balances
    await expect(validateWalletBalances(walletBalances, voidedTokenAuthorityBalances.walletBalances)).resolves.not.toThrow();

    // Validate transaction voiding consistency
    const voidingChecks = await performVoidingConsistencyChecks(mysql, {
      transactions: [
        { txId: 'efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539', expectedVoided: false },
        { txId: 'deabafb4b3e87a98ee60c5190c63de10809811818f663c040b29eaa0a92463af', expectedVoided: true },
        { txId: '4f5625892f602e191c22fd0aa533bea7764e93e3a03dc498d30cb23932eb462c', expectedVoided: false },
      ],
      utxos: [
        // No specific UTXO checks needed for this scenario
      ],
    });

    // Validate consistency
    validateVoidingConsistency(voidingChecks);
  }, 30000); // 30 second timeout for voided token authority test
});

describe('single voided create token transaction scenario', () => {
  const initializeWallet = async (mysql: Connection): Promise<void> => {
    // Insert wallet records
    const walletSQL = `
      INSERT INTO wallet (
          id,
          xpubkey,
          status,
          max_gap,
          created_at,
          ready_at,
          retry_count,
          auth_xpubkey,
          last_used_address_index
      ) VALUES
      (
          'test-wallet-voided-token',
          'xpub6F81iNtH5HVknoJ65cK2XAGA5F3okdJK7WHwVAAPZnSir2sfwbhvB9ffNKQ4wLor75QxPe9p12tqt8xUZSG8i8AAPMpkFho7fbWkBJQ5s1x',
          'ready',
          20,
          UNIX_TIMESTAMP(),
          UNIX_TIMESTAMP(),
          0,
          'xpub6F81iNtH5HVknoJ65cK2XAGA5F3okdJK7WHwVAAPZnSir2sfwbhvB9ffNKQ4wLor75QxPe9p12tqt8xUZSG8i8AAPMpkFho7fbWkBJQ5s1x',
          -1
      )`;

    // Insert address records that will receive the voided token
    const addressSQL = `
      INSERT INTO address (address, \`index\`, wallet_id, transactions, seqnum) VALUES
      ('HRQe4CXj8AZXzSmuNztU8iQR74QTQMbnTs', 0, 'test-wallet-voided-token', 0, 0)`;

    await mysql.query(walletSQL);
    await mysql.query(addressSQL);
  };

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
      FULLNODE_HOST: `127.0.0.1:${SINGLE_VOIDED_CREATE_TOKEN_TRANSACTION_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, SINGLE_VOIDED_CREATE_TOKEN_TRANSACTION_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);
    await expect(validateBalances(addressBalances, singleVoidedCreateTokenTransactionBalances.addressBalances)).resolves.not.toThrow();
  }, 30000);

  it('should expose the address_balance vs address_tx_history length mismatch issue', async () => {
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
      FULLNODE_HOST: `127.0.0.1:${SINGLE_VOIDED_CREATE_TOKEN_TRANSACTION_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
    });

    // Initialize wallet before processing events
    await initializeWallet(mysql);

    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, SINGLE_VOIDED_CREATE_TOKEN_TRANSACTION_LAST_EVENT);

    // Check for addresses that have balances for a specific token
    const addressBalanceResults = await mysql.query(`
      SELECT token_id,
             SUM(total_received) AS total_received,
             SUM(unlocked_balance) AS unlocked_balance,
             SUM(locked_balance) AS locked_balance,
             MIN(timelock_expires) AS timelock_expires,
             BIT_OR(unlocked_authorities) AS unlocked_authorities,
             BIT_OR(locked_authorities) AS locked_authorities
        FROM address_balance
       WHERE token_id LIKE '%' -- Get all tokens
    GROUP BY token_id
    ORDER BY token_id
    `);

    // Check for transaction history for the same tokens (excluding voided)
    const txHistoryResults = await mysql.query(`
      SELECT token_id,
             SUM(balance) AS balance,
             COUNT(DISTINCT tx_id) AS transactions
        FROM address_tx_history
       WHERE voided = FALSE
         AND token_id LIKE '%' -- Get all tokens
    GROUP BY token_id
    ORDER BY token_id
    `);

    console.log({
      addressBalanceResults,
      txHistoryResults
    });

    // Cast to array to access length property
    const addressRows = addressBalanceResults[0] as any[];
    const txHistoryRows = txHistoryResults[0] as any[];

    expect(addressRows.length).toEqual(txHistoryRows.length);

    // Verify that the voided token was removed from the token table
    const voidedTokenId = 'efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539';
    const tokenResults = await mysql.query(
      'SELECT * FROM token WHERE id = ?',
      [voidedTokenId]
    );

    // Token should not exist in the database after being voided
    expect(tokenResults[0]).toHaveLength(0);

    // Verify that the wallet_balance table doesn't contain the voided token
    const walletBalanceResults = await mysql.query(
      'SELECT * FROM wallet_balance WHERE token_id = ?',
      [voidedTokenId]
    );

    // Wallet balance should not exist for the voided token
    expect(walletBalanceResults[0]).toHaveLength(0);
  }, 30000);
});
