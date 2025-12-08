/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as db from '../../src/db';
import { handleVoidedTx, voidTx, handleTokenCreated } from '../../src/services';
import { LRU } from '../../src/utils';
import {
  addOrUpdateTx,
  addUtxos,
  updateTxOutputSpentBy,
  getTxOutput,
  unspendUtxos,
} from '../../src/db';
import {
  cleanDatabase,
  checkUtxoTable,
  createOutput,
  createInput,
  createEventTxInput,
  setupWallet,
  getWalletBalance,
  insertWalletBalance,
  getWalletTxHistoryCount,
} from '../utils';
import { DbTxOutput, EventTxInput } from '../../src/types';
import { Connection } from 'mysql2/promise';

/**
 * @jest-environment node
 */


// Use a single mysql connection for all tests
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
});

describe('handleVoidedTx (db)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle transactions with an empty list of inputs', async () => {
    const voidTxSpy = jest.spyOn(db, 'voidTransaction');
    voidTxSpy.mockResolvedValue();

    const context = {
      socket: expect.any(Object),
      healthcheck: expect.any(Object),
      retryAttempt: expect.any(Number),
      initialEventId: expect.any(Number),
      txCache: expect.any(LRU),
      event: {
        stream_id: 'stream-id',
        peer_id: 'peer_id',
        network: 'testnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: 4,
        event: {
          id: 5,
          data: {
            hash: 'random-hash',
            outputs: [],
            inputs: [],
            tokens: [],
          },
        },
      },
    };

    await expect(handleVoidedTx(context as any)).resolves.not.toThrow();

    const lastEvent = await db.getLastSyncedEvent(mysql);
    expect(db.voidTransaction).toHaveBeenCalledWith(
      expect.any(Object),
      'random-hash',
    );
    expect(lastEvent).toStrictEqual({
      id: expect.any(Number),
      last_event_id: 5,
      updated_at: expect.any(String),
    });
  });
});

describe('voidTransaction with input unspending', () => {
  it('should unspent inputs when voiding a transaction', async () => {
    expect.hasAssertions();

    // Create transaction A that creates an output
    const txIdA = 'test1-tx-a';
    const addressA = 'test1-address-a';
    const tokenId = '00';
    const outputValue = 100n;

    await addOrUpdateTx(mysql, txIdA, 0, 1, 1, 100);

    // Add output from transaction A
    const outputA = createOutput(0, outputValue, addressA, tokenId);
    await addUtxos(mysql, txIdA, [outputA], null);

    // Verify the UTXO is unspent
    let utxo = await getTxOutput(mysql, txIdA, 0, true);
    expect(utxo).not.toBeNull();
    expect(utxo?.spentBy).toBeNull();

    // Create transaction B that spends the output from transaction A
    const txIdB = 'test1-tx-b';
    const addressB = 'test1-address-b';

    await addOrUpdateTx(mysql, txIdB, 0, 1, 1, 101);

    // Mark the output from A as spent by B
    const inputB = createInput(outputValue, addressA, txIdA, 0, tokenId);
    await updateTxOutputSpentBy(mysql, [inputB], txIdB);

    // Verify the UTXO is now spent
    utxo = await getTxOutput(mysql, txIdA, 0, false);
    expect(utxo).not.toBeNull();
    expect(utxo?.spentBy).toBe(txIdB);

    // Add output from transaction B
    const outputB = createOutput(0, outputValue, addressB, tokenId);
    await addUtxos(mysql, txIdB, [outputB], null);


    // Now void transaction B using the voidTx service function
    const inputs = [createEventTxInput(outputValue, addressA, txIdA, 0)];
    const outputs = [{
      value: outputValue,
      locked: false,
      decoded: {
        type: 'P2PKH' as const,
        address: addressB,
        timelock: null,
      },
      token_data: 0,
      script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
    }];

    await voidTx(mysql, txIdB, inputs, outputs, [tokenId], [], 1);

    // Check if the UTXO from transaction A is unspent again
    utxo = await getTxOutput(mysql, txIdA, 0, false);
    expect(utxo).not.toBeNull();
    expect(utxo?.spentBy).toBeNull();
  });

  it('should unspent multiple inputs when voiding a transaction with multiple inputs', async () => {
    expect.hasAssertions();

    // Create transactions A and B that create outputs
    const txIdA = 'test2-tx-a';
    const txIdB = 'test2-tx-b';
    const txIdC = 'test2-tx-c'; // The transaction we'll void
    const address1 = 'test2-address-1';
    const address2 = 'test2-address-2';
    const address3 = 'test2-address-3';
    const tokenId = '00';

    // Create two UTXOs
    await addOrUpdateTx(mysql, txIdA, 0, 1, 1, 100);
    await addOrUpdateTx(mysql, txIdB, 0, 1, 1, 101);

    const outputA = createOutput(0, 50n, address1, tokenId);
    const outputB = createOutput(0, 75n, address2, tokenId);

    await addUtxos(mysql, txIdA, [outputA], null);
    await addUtxos(mysql, txIdB, [outputB], null);

    // Verify both UTXOs are unspent
    let utxoA = await getTxOutput(mysql, txIdA, 0, true);
    let utxoB = await getTxOutput(mysql, txIdB, 0, true);
    expect(utxoA?.spentBy).toBeNull();
    expect(utxoB?.spentBy).toBeNull();

    // Create transaction C that spends both outputs
    await addOrUpdateTx(mysql, txIdC, 0, 1, 1, 102);

    const inputC1 = createInput(50n, address1, txIdA, 0, tokenId);
    const inputC2 = createInput(75n, address2, txIdB, 0, tokenId);
    await updateTxOutputSpentBy(mysql, [inputC1, inputC2], txIdC);

    // Verify both UTXOs are now spent by C
    utxoA = await getTxOutput(mysql, txIdA, 0, false);
    utxoB = await getTxOutput(mysql, txIdB, 0, false);
    expect(utxoA?.spentBy).toBe(txIdC);
    expect(utxoB?.spentBy).toBe(txIdC);

    // Add output from transaction C
    const outputC = createOutput(0, 125n, address3, tokenId);
    await addUtxos(mysql, txIdC, [outputC], null);

    // Void transaction C using voidTx service function
    const inputs = [
      createEventTxInput(50n, address1, txIdA, 0),
      createEventTxInput(75n, address2, txIdB, 0),
    ];
    const outputs = [{
      value: 125n,
      locked: false,
      decoded: {
        type: 'P2PKH' as const,
        address: address3,
        timelock: null,
      },
      token_data: 0,
      script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
    }];

    await voidTx(mysql, txIdC, inputs, outputs, [tokenId], [], 1);

    // Check if UTXOs from transactions A and B are unspent again
    utxoA = await getTxOutput(mysql, txIdA, 0, true);
    utxoB = await getTxOutput(mysql, txIdB, 0, true);

    // Both outputs should be unspent again after voiding C (which was spending them)
    expect(utxoA).not.toBeNull();
    expect(utxoA?.spentBy).toBeNull(); // Should pass - should be null
    expect(utxoB).not.toBeNull();
    expect(utxoB?.spentBy).toBeNull(); // Should pass - should be null

    // The output from transaction C should be voided (not accessible with getTxOutput)
    const utxoC = await getTxOutput(mysql, txIdC, 0, false);
    expect(utxoC).toBeNull(); // Should be null because it's voided
  });

  it('should handle voiding a transaction that spends already voided outputs', async () => {
    expect.hasAssertions();

    // Create transaction A that creates an output
    const txIdA = 'test3-tx-a';
    const txIdB = 'test3-tx-b'; // Will be voided second
    const txIdC = 'test3-tx-c'; // Will be voided first
    const address1 = 'test3-address-1';
    const address2 = 'test3-address-2';
    const address3 = 'test3-address-3';
    const tokenId = '00';

    await addOrUpdateTx(mysql, txIdA, 0, 1, 1, 100);
    const outputA = createOutput(0, 100n, address1, tokenId);
    await addUtxos(mysql, txIdA, [outputA], null);

    // Transaction B spends A's output
    await addOrUpdateTx(mysql, txIdB, 0, 1, 1, 101);
    const inputB = createInput(100n, address1, txIdA, 0, tokenId);
    await updateTxOutputSpentBy(mysql, [inputB], txIdB);
    const outputB = createOutput(0, 100n, address2, tokenId);
    await addUtxos(mysql, txIdB, [outputB], null);
    
    // Only update address transaction counts (not balances) to prevent negative decrements
    await mysql.query('INSERT INTO address (address, transactions) VALUES (?, 1) ON DUPLICATE KEY UPDATE transactions = transactions + 1', [address1]);
    await mysql.query('INSERT INTO address (address, transactions) VALUES (?, 1) ON DUPLICATE KEY UPDATE transactions = transactions + 1', [address2]);

    // Transaction C spends B's output
    await addOrUpdateTx(mysql, txIdC, 0, 1, 1, 102);
    const inputC = createInput(100n, address2, txIdB, 0, tokenId);
    await updateTxOutputSpentBy(mysql, [inputC], txIdC);
    const outputC = createOutput(0, 100n, address3, tokenId);
    await addUtxos(mysql, txIdC, [outputC], null);
    
    // Only update address transaction counts (not balances) to prevent negative decrements  
    await mysql.query('INSERT INTO address (address, transactions) VALUES (?, 1) ON DUPLICATE KEY UPDATE transactions = transactions + 1', [address2]);
    await mysql.query('INSERT INTO address (address, transactions) VALUES (?, 1) ON DUPLICATE KEY UPDATE transactions = transactions + 1', [address3]);

    // First void transaction C
    await voidTx(mysql, txIdC,
      [createEventTxInput(100n, address2, txIdB, 0)],
      [{
        value: 100n,
        locked: false,
        decoded: { type: 'P2PKH' as const, address: address3, timelock: null },
        token_data: 0,
        script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
      }],
      [tokenId],
      [],
      1
    );

    // B's output should be unspent now (and it will be with the fix)
    let utxoB = await getTxOutput(mysql, txIdB, 0, true);
    expect(utxoB).not.toBeNull();
    expect(utxoB?.spentBy).toBeNull(); // Should pass - should be null

    // Now void transaction B
    await voidTx(mysql, txIdB,
      [createEventTxInput(100n, address1, txIdA, 0)],
      [{
        value: 100n,
        locked: false,
        decoded: { type: 'P2PKH' as const, address: address2, timelock: null },
        token_data: 0,
        script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
      }],
      [tokenId],
      [],
      1
    );

    // A's output should be unspent now
    let utxoA = await getTxOutput(mysql, txIdA, 0, true);
    expect(utxoA).not.toBeNull();
    expect(utxoA?.spentBy).toBeNull(); // Should pass - should be null

    // B's output should be voided (not accessible with getTxOutput)
    utxoB = await getTxOutput(mysql, txIdB, 0, false);
    expect(utxoB).toBeNull(); // Should be null because it's voided
  });

  it('should handle voiding when one input is already spent by another transaction', async () => {
    expect.hasAssertions();

    // This tests a double-spend scenario where we void a transaction
    // that claims to spend UTXOs already spent by another transaction.
    // This can happen during reorgs, network partitions, or double-spend attacks.

    const txIdA = 'test4-tx-a';
    const txIdB = 'test4-tx-b';
    const txIdC = 'test4-tx-c'; // Will try to spend A's output after B already spent it
    const address1 = 'test4-address-1';
    const address2 = 'test4-address-2';
    const tokenId = '00';

    // Create UTXO
    await addOrUpdateTx(mysql, txIdA, 0, 1, 1, 100);
    const outputA = createOutput(0, 100n, address1, tokenId);
    await addUtxos(mysql, txIdA, [outputA], null);

    // Transaction B spends it
    await addOrUpdateTx(mysql, txIdB, 0, 1, 1, 101);
    const inputB = createInput(100n, address1, txIdA, 0, tokenId);
    await updateTxOutputSpentBy(mysql, [inputB], txIdB);

    // Add output for transaction B
    const outputB = createOutput(0, 100n, address2, tokenId);
    await addUtxos(mysql, txIdB, [outputB], null);

    // Transaction C also tries to spend the same UTXO (double-spend scenario)
    // In reality, this would be detected and prevented, but we're testing edge cases
    await addOrUpdateTx(mysql, txIdC, 0, 1, 1, 102);

    // Add output for transaction C (this transaction exists but its input reference is invalid)
    const outputC = createOutput(0, 100n, address2, tokenId);
    await addUtxos(mysql, txIdC, [outputC], null);

    // Now void transaction C which claims to spend an already-spent output
    const inputs = [createEventTxInput(100n, address1, txIdA, 0)];
    const outputs = [{
      value: 100n,
      locked: false,
      decoded: { type: 'P2PKH' as const, address: address2, timelock: null },
      token_data: 0,
      script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
    }];

    await voidTx(mysql, txIdC, inputs, outputs, [tokenId], [], 1);

    // The UTXO should still be spent by B, not unspent
    const utxo = await getTxOutput(mysql, txIdA, 0, false);
    expect(utxo).not.toBeNull();
    expect(utxo?.spentBy).toBe(txIdB); // Should remain spent by B
  });

  it('should correctly unspent inputs with different token types', async () => {
    expect.hasAssertions();

    const txIdA = 'test5-tx-a';
    const txIdB = 'test5-tx-b';
    const address1 = 'test5-address-1';
    const address2 = 'test5-address-2';
    const hathorToken = '00';
    const customToken = 'custom-token-id';

    // Create two UTXOs with different tokens
    await addOrUpdateTx(mysql, txIdA, 0, 1, 1, 100);
    const outputA1 = createOutput(0, 100n, address1, hathorToken);
    const outputA2 = createOutput(1, 50n, address1, customToken);
    await addUtxos(mysql, txIdA, [outputA1, outputA2], null);

    // Transaction B spends both
    await addOrUpdateTx(mysql, txIdB, 0, 1, 1, 101);
    const inputB1 = createInput(100n, address1, txIdA, 0, hathorToken);
    const inputB2 = createInput(50n, address1, txIdA, 1, customToken);
    await updateTxOutputSpentBy(mysql, [inputB1, inputB2], txIdB);

    // Add outputs for transaction B
    const outputB1 = createOutput(0, 100n, address2, hathorToken);
    const outputB2 = createOutput(1, 50n, address2, customToken);
    await addUtxos(mysql, txIdB, [outputB1, outputB2], null);

    // Void transaction B
    const inputs = [
      createEventTxInput(100n, address1, txIdA, 0),
      createEventTxInput(50n, address1, txIdA, 1),
    ];
    const outputs = [
      {
        value: 100n,
        locked: false,
        decoded: { type: 'P2PKH' as const, address: address2, timelock: null },
        token_data: 0,
        script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
      },
      {
        value: 50n,
        locked: false,
        decoded: { type: 'P2PKH' as const, address: address2, timelock: null },
        token_data: 0,
        script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
      }
    ];

    await voidTx(mysql, txIdB, inputs, outputs, [hathorToken, customToken], [], 1);

    // Both UTXOs should be unspent
    const utxo1 = await getTxOutput(mysql, txIdA, 0, true);
    const utxo2 = await getTxOutput(mysql, txIdA, 1, true);

    // These should pass with the implementation
    expect(utxo1).not.toBeNull();
    expect(utxo1?.spentBy).toBeNull();
    expect(utxo2).not.toBeNull();
    expect(utxo2?.spentBy).toBeNull();
  });

  it('should verify the complete flow with balance checks', async () => {
    expect.hasAssertions();

    // Complete integration test
    const txIdA = 'test6-tx-a';
    const txIdB = 'test6-tx-b';
    const address1 = 'test6-address-1';
    const address2 = 'test6-address-2';
    const tokenId = '00';
    const value = 200n;

    // Setup initial UTXO
    await addOrUpdateTx(mysql, txIdA, 0, 1, 1, 100);
    const outputA = createOutput(0, value, address1, tokenId);
    await addUtxos(mysql, txIdA, [outputA], null);

    // Verify initial state
    await expect(checkUtxoTable(mysql, 1, txIdA, 0, tokenId, address1, value, 0, null, null, false, null)).resolves.toBe(true);

    // Create spending transaction
    await addOrUpdateTx(mysql, txIdB, 0, 1, 1, 101);
    const inputB = createInput(value, address1, txIdA, 0, tokenId);
    await updateTxOutputSpentBy(mysql, [inputB], txIdB);
    const outputB = createOutput(0, value, address2, tokenId);
    await addUtxos(mysql, txIdB, [outputB], null);

    // Verify spent state
    const spentUtxo = await getTxOutput(mysql, txIdA, 0, false);
    expect(spentUtxo?.spentBy).toBe(txIdB);

    // Void the spending transaction
    const inputs = [createEventTxInput(value, address1, txIdA, 0)];
    const outputs = [{
      value,
      locked: false,
      decoded: { type: 'P2PKH' as const, address: address2, timelock: null },
      token_data: 0,
      script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
    }];

    await voidTx(mysql, txIdB, inputs, outputs, [tokenId], [], 1);

    // Verify the original UTXO is unspent again
    const unspentUtxo = await getTxOutput(mysql, txIdA, 0, true);
    expect(unspentUtxo).not.toBeNull();
    expect(unspentUtxo?.spentBy).toBeNull(); // This should pass

    // Also verify that B's outputs are marked as voided
    const voidedUtxo = await getTxOutput(mysql, txIdB, 0, false);
    expect(voidedUtxo).toBeNull(); // Should be null because it's voided
  });
});

describe('unspentTxOutputs function', () => {
  it('should correctly unspent transaction outputs', async () => {
    expect.hasAssertions();

    // This tests the unspentTxOutputs function directly
    const txIdA = 'test7-tx-a';
    const txIdB = 'test7-tx-b';
    const txIdC = 'test7-tx-c';
    const spendingTx = 'test7-spending-tx';
    const address = 'test7-address';
    const tokenId = '00';

    // Create multiple UTXOs
    await addOrUpdateTx(mysql, txIdA, 0, 1, 1, 100);
    await addOrUpdateTx(mysql, txIdB, 0, 1, 1, 101);
    await addOrUpdateTx(mysql, txIdC, 0, 1, 1, 102);

    const outputs = [
      createOutput(0, 50n, address, tokenId),
      createOutput(0, 75n, address, tokenId),
      createOutput(0, 100n, address, tokenId),
    ];

    await addUtxos(mysql, txIdA, [outputs[0]], null);
    await addUtxos(mysql, txIdB, [outputs[1]], null);
    await addUtxos(mysql, txIdC, [outputs[2]], null);

    // Mark them all as spent
    const inputs = [
      createInput(50n, address, txIdA, 0, tokenId),
      createInput(75n, address, txIdB, 0, tokenId),
      createInput(100n, address, txIdC, 0, tokenId),
    ];
    await updateTxOutputSpentBy(mysql, inputs, spendingTx);

    // Verify they are spent
    let utxoA = await getTxOutput(mysql, txIdA, 0, false);
    let utxoB = await getTxOutput(mysql, txIdB, 0, false);
    let utxoC = await getTxOutput(mysql, txIdC, 0, false);
    expect(utxoA?.spentBy).toBe(spendingTx);
    expect(utxoB?.spentBy).toBe(spendingTx);
    expect(utxoC?.spentBy).toBe(spendingTx);

    // Now unspent them
    const txOutputsToUnspent: DbTxOutput[] = [
      { txId: txIdA, index: 0, tokenId, address, value: 50n, authorities: 0, timelock: null, heightlock: null, locked: false, spentBy: spendingTx, txProposalId: null, txProposalIndex: null },
      { txId: txIdB, index: 0, tokenId, address, value: 75n, authorities: 0, timelock: null, heightlock: null, locked: false, spentBy: spendingTx, txProposalId: null, txProposalIndex: null },
      { txId: txIdC, index: 0, tokenId, address, value: 100n, authorities: 0, timelock: null, heightlock: null, locked: false, spentBy: spendingTx, txProposalId: null, txProposalIndex: null },
    ];

    await unspendUtxos(mysql, txOutputsToUnspent);

    // Verify they are unspent
    utxoA = await getTxOutput(mysql, txIdA, 0, true);
    utxoB = await getTxOutput(mysql, txIdB, 0, true);
    utxoC = await getTxOutput(mysql, txIdC, 0, true);
    expect(utxoA).not.toBeNull();
    expect(utxoA?.spentBy).toBeNull();
    expect(utxoB).not.toBeNull();
    expect(utxoB?.spentBy).toBeNull();
    expect(utxoC).not.toBeNull();
    expect(utxoC?.spentBy).toBeNull();
  });
});


describe('wallet balance voiding bug', () => {
  it('should demonstrate wallet balance not being updated when voiding a transaction', async () => {
    expect.hasAssertions();

    const walletId = 'test-wallet';
    const address = 'test-address';
    const tokenId = '00';
    const txIdA = 'tx-a';
    const txIdB = 'tx-b';
    const initialValue = 100n;

    // Setup wallet and address
    await setupWallet(mysql, walletId, [address]);

    // Create transaction A that creates an output to our wallet address
    await addOrUpdateTx(mysql, txIdA, 0, 1, 1, 100);
    const outputA = createOutput(0, initialValue, address, tokenId);
    await addUtxos(mysql, txIdA, [outputA], null);

    // Manually insert wallet balance (simulating what updateWalletTablesWithTx would do)
    await insertWalletBalance(mysql, walletId, tokenId, initialValue, 1);

    // Also insert into wallet_tx_history
    await mysql.query(
      `INSERT INTO \`wallet_tx_history\` (wallet_id, token_id, tx_id, balance, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      [walletId, tokenId, txIdA, initialValue, 100]
    );

    // Verify initial wallet balance
    let walletBalance = await getWalletBalance(mysql, walletId, tokenId);
    expect(walletBalance).not.toBeNull();
    expect(BigInt(walletBalance.unlocked_balance)).toBe(initialValue);
    expect(walletBalance.transactions).toBe(1);

    // Create transaction B that spends the output from A
    await addOrUpdateTx(mysql, txIdB, 0, 1, 1, 101);
    const inputB = createInput(initialValue, address, txIdA, 0, tokenId);
    await updateTxOutputSpentBy(mysql, [inputB], txIdB);

    // Add output for transaction B (sending to same address for simplicity)
    const outputB = createOutput(0, initialValue, address, tokenId);
    await addUtxos(mysql, txIdB, [outputB], null);

    // Update wallet balance for transaction B (net zero change)
    await insertWalletBalance(mysql, walletId, tokenId, 0n, 1);

    // Add to wallet_tx_history
    await mysql.query(
      `INSERT INTO \`wallet_tx_history\` (wallet_id, token_id, tx_id, balance, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      [walletId, tokenId, txIdB, 0, 101]
    );

    // Verify wallet balance after transaction B
    walletBalance = await getWalletBalance(mysql, walletId, tokenId);
    expect(walletBalance).not.toBeNull();
    expect(BigInt(walletBalance.unlocked_balance)).toBe(initialValue); // Still 100n
    expect(walletBalance.transactions).toBe(2); // Now 2 transactions

    // Now void transaction B
    const inputs: EventTxInput[] = [createEventTxInput(initialValue, address, txIdA, 0)];
    const outputs = [{
      value: initialValue,
      locked: false,
      decoded: {
        type: 'P2PKH' as const,
        address: address,
        timelock: null,
      },
      token_data: 0,
      script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
    }];

    await voidTx(mysql, txIdB, inputs, outputs, [tokenId], [], 1);

    // Check wallet balance after voiding
    walletBalance = await getWalletBalance(mysql, walletId, tokenId);
    expect(walletBalance).not.toBeNull();

    // The transaction count should decrease from 2 to 1
    expect(walletBalance.transactions).toBe(1); // Should be back to 1 transaction

    // Check if wallet_tx_history was cleaned up
    const historyCount = await getWalletTxHistoryCount(mysql, walletId, txIdB);
    expect(historyCount).toBe(0); // Should be 0 after voiding
  });

  it('should demonstrate wallet balance inconsistency with multiple wallets', async () => {
    expect.hasAssertions();

    const wallet1Id = 'wallet-1';
    const wallet2Id = 'wallet-2';
    const address1 = 'address-1';
    const address2 = 'address-2';
    const tokenId = '00';
    const txId = 'transfer-tx';
    const amount = 150n;

    // Setup two wallets
    await setupWallet(mysql, wallet1Id, [address1]);
    await setupWallet(mysql, wallet2Id, [address2]);

    // Simulate wallet1 already having some balance
    await insertWalletBalance(mysql, wallet1Id, tokenId, 200n, 1);

    // Create a transaction that transfers money from wallet1 to wallet2
    await addOrUpdateTx(mysql, txId, 0, 1, 1, 100);

    // Transaction sends money from wallet1 to wallet2
    const outputs = [
      createOutput(0, amount, address2, tokenId), // To wallet2
    ];
    await addUtxos(mysql, txId, outputs, null);

    // Simulate updating wallet balances for this transaction
    // Wallet1 loses money (net -150n)
    await mysql.query(
      `UPDATE \`wallet_balance\`
       SET unlocked_balance = unlocked_balance - ?, transactions = transactions + 1
       WHERE wallet_id = ? AND token_id = ?`,
      [amount, wallet1Id, tokenId]
    );

    // Wallet2 gains money (+150n)
    await insertWalletBalance(mysql, wallet2Id, tokenId, amount, 1);

    // Add wallet_tx_history entries
    await mysql.query(
      `INSERT INTO \`wallet_tx_history\` (wallet_id, token_id, tx_id, balance, timestamp)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      [wallet1Id, tokenId, txId, -amount, 100, wallet2Id, tokenId, txId, amount, 100]
    );

    // Verify wallet balances before voiding
    let wallet1Balance = await getWalletBalance(mysql, wallet1Id, tokenId);
    let wallet2Balance = await getWalletBalance(mysql, wallet2Id, tokenId);

    expect(wallet1Balance).not.toBeNull();
    expect(BigInt(wallet1Balance.unlocked_balance)).toBe(50n); // 200 - 150
    expect(wallet1Balance.transactions).toBe(2);

    expect(wallet2Balance).not.toBeNull();
    expect(BigInt(wallet2Balance.unlocked_balance)).toBe(amount);
    expect(wallet2Balance.transactions).toBe(1);

    // Now void the transaction
    const inputs: EventTxInput[] = [createEventTxInput(amount, address1, 'some-previous-tx', 0)];
    const voidOutputs = [{
      value: amount,
      locked: false,
      decoded: {
        type: 'P2PKH' as const,
        address: address2,
        timelock: null,
      },
      token_data: 0,
      script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
    }];

    await voidTx(mysql, txId, inputs, voidOutputs, [tokenId], [], 1);

    // Check wallet balances after voiding
    wallet1Balance = await getWalletBalance(mysql, wallet1Id, tokenId);
    wallet2Balance = await getWalletBalance(mysql, wallet2Id, tokenId);

    // Wallet1 should have its balance restored (50 + 150 = 200)
    expect(BigInt(wallet1Balance.unlocked_balance)).toBe(200n);
    expect(wallet1Balance.transactions).toBe(1); // Should decrease back to 1

    // Wallet2 should have its balance reduced to 0
    if (wallet2Balance) {
      expect(BigInt(wallet2Balance.unlocked_balance)).toBe(0n);
      expect(wallet2Balance.transactions).toBe(0); // Should be 0 after voiding
    }

    // Check wallet_tx_history cleanup
    const wallet1HistoryCount = await getWalletTxHistoryCount(mysql, wallet1Id, txId);
    const wallet2HistoryCount = await getWalletTxHistoryCount(mysql, wallet2Id, txId);

    expect(wallet1HistoryCount).toBe(0);
    expect(wallet2HistoryCount).toBe(0);
  });

  it('should demonstrate the bug exists even with simple single wallet scenario', async () => {
    expect.hasAssertions();

    const walletId = 'simple-wallet';
    const address = 'simple-address';
    const tokenId = '00';
    const txId = 'simple-tx';
    const value = 50n;

    // Setup wallet
    await setupWallet(mysql, walletId, [address]);

    // Create transaction
    await addOrUpdateTx(mysql, txId, 0, 1, 1, 100);
    const output = createOutput(0, value, address, tokenId);
    await addUtxos(mysql, txId, [output], null);

    // Simulate wallet balance update
    await insertWalletBalance(mysql, walletId, tokenId, value, 1);
    await mysql.query(
      `INSERT INTO \`wallet_tx_history\` (wallet_id, token_id, tx_id, balance, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      [walletId, tokenId, txId, value, 100]
    );

    // Verify wallet balance exists
    let walletBalance = await getWalletBalance(mysql, walletId, tokenId);
    expect(walletBalance).not.toBeNull();
    expect(BigInt(walletBalance.unlocked_balance)).toBe(value);
    expect(walletBalance.transactions).toBe(1);

    // Void the transaction
    const inputs: EventTxInput[] = [];
    const outputs = [{
      value: value,
      locked: false,
      decoded: {
        type: 'P2PKH' as const,
        address: address,
        timelock: null,
      },
      token_data: 0,
      script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
    }];

    await voidTx(mysql, txId, inputs, outputs, [tokenId], [], 1);

    // Check wallet balance after voiding
    walletBalance = await getWalletBalance(mysql, walletId, tokenId);

    if (walletBalance) {
      expect(BigInt(walletBalance.unlocked_balance)).toBe(0n); // Should be 0 after voiding
      expect(walletBalance.transactions).toBe(0); // Should be 0 after voiding
    }

    // Check wallet_tx_history cleanup
    const historyCount = await getWalletTxHistoryCount(mysql, walletId, txId);
    expect(historyCount).toBe(0); // Should be 0 after voiding
  });

  test('should clear tx_proposal marks when voiding a transaction', async () => {
    expect.hasAssertions();
    await cleanDatabase(mysql);

    const address1 = 'HBCQgVR8Xsyv3L8spWJLQCJkbgj1YABWMU';
    const tokenId = '00';
    const txProposalId = 'test-proposal-123';
    const txProposalIndex = 0;

    // Transaction A: Initial transaction with one output
    const txIdA = 'txA';
    const outputsA = [createOutput(0, 100n, address1, tokenId)];
    await addOrUpdateTx(mysql, txIdA, 10, 1000, 1, 10);
    await addUtxos(mysql, txIdA, outputsA, null);

    // Mark the UTXO with a tx_proposal (simulating it being selected for a transaction)
    await mysql.query(
      `UPDATE \`tx_output\`
          SET \`tx_proposal\` = ?,
              \`tx_proposal_index\` = ?
        WHERE tx_id = ? AND \`index\` = ?`,
      [txProposalId, txProposalIndex, txIdA, 0]
    );

    // Verify the tx_proposal is set
    const utxoBeforeTx = await getTxOutput(mysql, txIdA, 0, false);
    expect(utxoBeforeTx).not.toBeNull();
    expect(utxoBeforeTx!.txProposalId).toBe(txProposalId);
    expect(utxoBeforeTx!.txProposalIndex).toBe(txProposalIndex);

    // Transaction B: Uses the output from A as input
    const txIdB = 'txB';
    const inputsB = [createInput(100n, address1, txIdA, 0, tokenId)];
    const outputsB = [createOutput(0, 100n, address1, tokenId)];

    await addOrUpdateTx(mysql, txIdB, 11, 1001, 1, 11);
    await addUtxos(mysql, txIdB, outputsB, null);
    await updateTxOutputSpentBy(mysql, inputsB, txIdB);

    // Verify the UTXO is marked as spent
    const utxoAfterSpent = await getTxOutput(mysql, txIdA, 0, false);
    expect(utxoAfterSpent).not.toBeNull();
    expect(utxoAfterSpent!.spentBy).toBe(txIdB);

    // Now void transaction B
    const inputs = [createEventTxInput(100n, address1, txIdA, 0)];

    const outputs = [{
      value: 100n,
      token_data: 0,
      script: 'dqkU',
      decoded: {
        type: 'P2PKH',
        address: address1,
        timelock: null,
      },
      token: tokenId,
      spent_by: null,
    }];

    await voidTx(mysql, txIdB, inputs, outputs, [tokenId], [], 1);

    // Check that the tx_proposal marks have been cleared
    const utxoAfterVoid = await getTxOutput(mysql, txIdA, 0, false);
    expect(utxoAfterVoid).not.toBeNull();
    expect(utxoAfterVoid!.txProposalId).toBeNull(); // Should be cleared
    expect(utxoAfterVoid!.txProposalIndex).toBeNull(); // Should be cleared
    expect(utxoAfterVoid!.spentBy).toBeNull(); // Should be unspent again
  });

  test('should clear tx_proposal marks for multiple inputs when voiding', async () => {
    expect.hasAssertions();
    await cleanDatabase(mysql);

    const address1 = 'HBCQgVR8Xsyv3L8spWJLQCJkbgj1YABWMU';
    const tokenId = '00';
    const txProposalId = 'test-proposal-456';

    // Create two initial UTXOs
    const txIdA = 'txA';
    const outputsA = [
      createOutput(0, 50n, address1, tokenId),
      createOutput(1, 50n, address1, tokenId)
    ];
    await addOrUpdateTx(mysql, txIdA, 10, 1000, 1, 10);
    await addUtxos(mysql, txIdA, outputsA, null);

    // Mark both UTXOs with the same tx_proposal
    await mysql.query(
      `UPDATE \`tx_output\`
          SET \`tx_proposal\` = ?,
              \`tx_proposal_index\` = ?
        WHERE tx_id = ?`,
      [txProposalId, 0, txIdA]
    );

    // Transaction B: Uses both outputs from A as inputs
    const txIdB = 'txB';
    const inputsB = [
      createInput(50n, address1, txIdA, 0, tokenId),
      createInput(50n, address1, txIdA, 1, tokenId)
    ];
    const outputsB = [createOutput(0, 100n, address1, tokenId)];

    await addOrUpdateTx(mysql, txIdB, 11, 1001, 1, 11);
    await addUtxos(mysql, txIdB, outputsB, null);
    await updateTxOutputSpentBy(mysql, inputsB, txIdB);

    // Prepare inputs for voidTx
    const inputs = [
      createEventTxInput(50n, address1, txIdA, 0),
      createEventTxInput(50n, address1, txIdA, 1)
    ];

    const outputs = [{
      value: 100n,
      token_data: 0,
      script: 'dqkU',
      decoded: {
        type: 'P2PKH',
        address: address1,
        timelock: null,
      },
      token: tokenId,
      spent_by: null,
    }];

    await voidTx(mysql, txIdB, inputs, outputs, [tokenId], [], 1);

    // Check that tx_proposal marks have been cleared for both inputs
    const utxo1AfterVoid = await getTxOutput(mysql, txIdA, 0, false);
    expect(utxo1AfterVoid).not.toBeNull();
    expect(utxo1AfterVoid!.txProposalId).toBeNull();
    expect(utxo1AfterVoid!.txProposalIndex).toBeNull();
    expect(utxo1AfterVoid!.spentBy).toBeNull();

    const utxo2AfterVoid = await getTxOutput(mysql, txIdA, 1, false);
    expect(utxo2AfterVoid).not.toBeNull();
    expect(utxo2AfterVoid!.txProposalId).toBeNull();
    expect(utxo2AfterVoid!.txProposalIndex).toBeNull();
    expect(utxo2AfterVoid!.spentBy).toBeNull();
  });

  it('should delete tokens when voiding transaction that created them', async () => {
    expect.hasAssertions();
    await cleanDatabase(mysql);

    const txId = 'nano-tx-001';
    const tokenId1 = 'token001';
    const tokenId2 = 'token002';
    const tokenId3 = 'token003';

    // Add tokens to database
    await db.storeTokenInformation(mysql, tokenId1, 'Token 1', 'TK1');
    await db.storeTokenInformation(mysql, tokenId2, 'Token 2', 'TK2');
    await db.storeTokenInformation(mysql, tokenId3, 'Token 3', 'TK3');

    // Create mappings (simulate nano contract creating multiple tokens)
    await db.insertTokenCreation(mysql, tokenId1, txId);
    await db.insertTokenCreation(mysql, tokenId2, txId);
    await db.insertTokenCreation(mysql, tokenId3, txId);

    // Verify tokens and mappings exist
    let token1 = await db.getTokenInformation(mysql, tokenId1);
    expect(token1).not.toBeNull();
    let tokens = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokens).toHaveLength(3);

    // Void the transaction with empty inputs/outputs/tokens
    await voidTx(mysql, txId, [], [], [], [], 1);

    // Verify all tokens created by this tx were deleted
    token1 = await db.getTokenInformation(mysql, tokenId1);
    expect(token1).toBeNull();

    const token2 = await db.getTokenInformation(mysql, tokenId2);
    expect(token2).toBeNull();

    const token3 = await db.getTokenInformation(mysql, tokenId3);
    expect(token3).toBeNull();

    // Verify mappings were also deleted
    tokens = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokens).toHaveLength(0);
  });
});

describe('handleTokenCreated (db)', () => {
  beforeEach(async () => {
    await cleanDatabase(mysql);
    jest.clearAllMocks();
  });

  it('should store token and create mapping', async () => {
    expect.hasAssertions();

    const tokenId = 'token-uid-001';
    const txId = 'tx-001';
    const tokenName = 'My Token';
    const tokenSymbol = 'MTK';

    const context = {
      socket: expect.any(Object),
      healthcheck: expect.any(Object),
      retryAttempt: 0,
      initialEventId: null,
      txCache: new LRU(100),
      event: {
        stream_id: 'stream-id',
        peer_id: 'peer-id',
        network: 'testnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: 10,
        event: {
          id: 11,
          timestamp: 1234567890.123,
          type: 'TOKEN_CREATED',
          data: {
            token_uid: tokenId,
            nc_exec_info: {
              nc_tx: txId,
              nc_block: 'block-001',
            },
            token_name: tokenName,
            token_symbol: tokenSymbol,
            token_version: 'TOKEN_VERSION_1',
            initial_amount: 1000000,
          },
          group_id: null,
        },
      },
    };

    await handleTokenCreated(context as any);

    // Verify token was stored
    const token = await db.getTokenInformation(mysql, tokenId);
    expect(token).not.toBeNull();
    expect(token?.name).toBe(tokenName);
    expect(token?.symbol).toBe(tokenSymbol);

    // Verify mapping was created
    const tokensCreated = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensCreated).toHaveLength(1);
    expect(tokensCreated[0]).toBe(tokenId);

    // Verify last synced event was updated
    const lastEvent = await db.getLastSyncedEvent(mysql);
    expect(lastEvent).not.toBeNull();
    expect(lastEvent?.last_event_id).toBe(11);
  });

  it('should handle multiple tokens from same nano contract', async () => {
    expect.hasAssertions();

    const txId = 'nano-tx-001';
    const tokenId1 = 'token-uid-001';
    const tokenId2 = 'token-uid-002';

    // Create first TOKEN_CREATED event
    const context1 = {
      socket: expect.any(Object),
      healthcheck: expect.any(Object),
      retryAttempt: 0,
      initialEventId: null,
      txCache: new LRU(100),
      event: {
        stream_id: 'stream-id',
        peer_id: 'peer-id',
        network: 'testnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: 10,
        event: {
          id: 11,
          timestamp: 1234567890.123,
          type: 'TOKEN_CREATED',
          data: {
            token_uid: tokenId1,
            nc_exec_info: {
              nc_tx: txId,
              nc_block: 'block-001',
            },
            token_name: 'Token 1',
            token_symbol: 'TK1',
            token_version: 'TOKEN_VERSION_1',
            initial_amount: 1000000,
          },
          group_id: null,
        },
      },
    };

    // Create second TOKEN_CREATED event
    const context2 = {
      ...context1,
      event: {
        ...context1.event,
        event: {
          ...context1.event.event,
          id: 12,
          data: {
            token_uid: tokenId2,
            nc_exec_info: {
              nc_tx: txId,
              nc_block: 'block-001',
            },
            token_name: 'Token 2',
            token_symbol: 'TK2',
            token_version: 'TOKEN_VERSION_1',
            initial_amount: 2000000,
          },
        },
      },
    };

    await handleTokenCreated(context1 as any);
    await handleTokenCreated(context2 as any);

    // Verify both tokens were stored
    const token1 = await db.getTokenInformation(mysql, tokenId1);
    expect(token1).not.toBeNull();
    expect(token1?.name).toBe('Token 1');

    const token2 = await db.getTokenInformation(mysql, tokenId2);
    expect(token2).not.toBeNull();
    expect(token2?.name).toBe('Token 2');

    // Verify both mappings point to same tx
    const tokensCreated = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensCreated).toHaveLength(2);
    expect(tokensCreated).toContain(tokenId1);
    expect(tokensCreated).toContain(tokenId2);
  });
});

describe('Nano contract token deletion on nc_execution change', () => {
  beforeEach(async () => {
    await cleanDatabase(mysql);
    jest.clearAllMocks();
  });

  it('should delete nano-created tokens when nc_execution changes from success to pending', async () => {
    const txId = 'nano-tx-001';
    const tokenId = 'token-from-nano-001';

    // First, create the token (simulating when nc_execution was SUCCESS)
    await db.storeTokenInformation(mysql, tokenId, 'NC Token', 'NCT');
    await db.insertTokenCreation(mysql, tokenId, txId);

    // Verify token exists
    let token = await db.getTokenInformation(mysql, tokenId);
    expect(token).not.toBeNull();

    // Verify mapping exists
    let tokensCreated = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensCreated).toHaveLength(1);
    expect(tokensCreated[0]).toBe(tokenId);

    // Now delete tokens (simulating nc_execution changing to PENDING)
    await db.deleteTokens(mysql, [tokenId]);
    await db.deleteTokenCreationMappings(mysql, [tokenId]);

    // Verify token was deleted
    token = await db.getTokenInformation(mysql, tokenId);
    expect(token).toBeNull();

    // Verify mapping was deleted
    tokensCreated = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensCreated).toHaveLength(0);
  });

  it('should delete multiple nano-created tokens when nc_execution changes', async () => {
    const txId = 'nano-tx-002';
    const tokenId1 = 'token-from-nano-002-1';
    const tokenId2 = 'token-from-nano-002-2';

    // Create two tokens from the same nano contract execution
    await db.storeTokenInformation(mysql, tokenId1, 'NC Token 1', 'NCT1');
    await db.insertTokenCreation(mysql, tokenId1, txId);

    await db.storeTokenInformation(mysql, tokenId2, 'NC Token 2', 'NCT2');
    await db.insertTokenCreation(mysql, tokenId2, txId);

    // Verify both tokens exist
    let token1 = await db.getTokenInformation(mysql, tokenId1);
    let token2 = await db.getTokenInformation(mysql, tokenId2);
    expect(token1).not.toBeNull();
    expect(token2).not.toBeNull();

    // Verify both mappings exist
    let tokensCreated = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensCreated).toHaveLength(2);

    // Delete all tokens created by this nano contract
    await db.deleteTokens(mysql, tokensCreated);
    await db.deleteTokenCreationMappings(mysql, tokensCreated);

    // Verify both tokens were deleted
    token1 = await db.getTokenInformation(mysql, tokenId1);
    token2 = await db.getTokenInformation(mysql, tokenId2);
    expect(token1).toBeNull();
    expect(token2).toBeNull();

    // Verify both mappings were deleted
    tokensCreated = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensCreated).toHaveLength(0);
  });

  it('should allow token re-creation after deletion (idempotency test)', async () => {
    const txId = 'nano-tx-003';
    const tokenId = 'token-from-nano-003';
    const tokenName = 'NC Token Recreated';
    const tokenSymbol = 'NCTR';

    // Create token first time
    await db.storeTokenInformation(mysql, tokenId, tokenName, tokenSymbol);
    await db.insertTokenCreation(mysql, tokenId, txId);

    // Delete it (simulating nc_execution change to PENDING)
    await db.deleteTokens(mysql, [tokenId]);
    await db.deleteTokenCreationMappings(mysql, [tokenId]);

    // Verify it's deleted
    let token = await db.getTokenInformation(mysql, tokenId);
    expect(token).toBeNull();

    // Re-create it (simulating nano execution again after reorg)
    await db.storeTokenInformation(mysql, tokenId, tokenName, tokenSymbol);
    await db.insertTokenCreation(mysql, tokenId, txId);

    // Verify token was re-created
    token = await db.getTokenInformation(mysql, tokenId);
    expect(token).not.toBeNull();
    expect(token?.name).toBe(tokenName);
    expect(token?.symbol).toBe(tokenSymbol);

    // Verify mapping was re-created
    const tokensCreated = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensCreated).toHaveLength(1);
    expect(tokensCreated[0]).toBe(tokenId);
  });
});

describe('Hybrid transaction token deletion scenarios', () => {
  beforeEach(async () => {
    await cleanDatabase(mysql);
    jest.clearAllMocks();
  });

  it('should handle hybrid transaction - keep CREATE_TOKEN_TX token when only nc_execution changes', async () => {
    const txId = 'hybrid-tx-001';
    const createTokenTxTokenId = txId; // CREATE_TOKEN_TX token has same ID as tx
    const nanoTokenId = 'nano-created-token-001';

    // Step 1: CREATE_TOKEN_TX token arrives (immediately when tx hits mempool)
    await db.storeTokenInformation(mysql, createTokenTxTokenId, 'Hybrid Token', 'HYB');
    await db.insertTokenCreation(mysql, createTokenTxTokenId, txId);

    // Step 2: Nano executes successfully and creates additional token
    await db.storeTokenInformation(mysql, nanoTokenId, 'NC Token', 'NCT');
    await db.insertTokenCreation(mysql, nanoTokenId, txId);

    // Verify both tokens exist
    let createTokenTxToken = await db.getTokenInformation(mysql, createTokenTxTokenId);
    let nanoToken = await db.getTokenInformation(mysql, nanoTokenId);
    expect(createTokenTxToken).not.toBeNull();
    expect(nanoToken).not.toBeNull();

    // Verify both mappings exist
    let tokensCreated = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensCreated).toHaveLength(2);

    // Step 3: Reorg happens - nc_execution changes to PENDING
    // Only delete nano-created token, not the CREATE_TOKEN_TX token
    await db.deleteTokens(mysql, [nanoTokenId]);
    await db.deleteTokenCreationMappings(mysql, [nanoTokenId]);

    // Verify: nano token deleted, CREATE_TOKEN_TX token remains
    createTokenTxToken = await db.getTokenInformation(mysql, createTokenTxTokenId);
    nanoToken = await db.getTokenInformation(mysql, nanoTokenId);
    expect(createTokenTxToken).not.toBeNull();
    expect(nanoToken).toBeNull();

    // Verify only CREATE_TOKEN_TX token mapping remains
    tokensCreated = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensCreated).toHaveLength(1);
    expect(tokensCreated[0]).toBe(createTokenTxTokenId);

    // Step 4: Nano executes again - token re-created
    await db.storeTokenInformation(mysql, nanoTokenId, 'NC Token', 'NCT');
    await db.insertTokenCreation(mysql, nanoTokenId, txId);

    // Verify both tokens exist again
    createTokenTxToken = await db.getTokenInformation(mysql, createTokenTxTokenId);
    nanoToken = await db.getTokenInformation(mysql, nanoTokenId);
    expect(createTokenTxToken).not.toBeNull();
    expect(nanoToken).not.toBeNull();

    // Verify both mappings exist again
    tokensCreated = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensCreated).toHaveLength(2);
  });

  it('should handle hybrid transaction - delete all tokens when transaction is voided', async () => {
    const txId = 'hybrid-tx-002';
    const createTokenTxTokenId = txId;
    const nanoTokenId = 'nano-created-token-002';

    // Create both tokens (CREATE_TOKEN_TX token + nano-created token)
    await db.storeTokenInformation(mysql, createTokenTxTokenId, 'Hybrid Token 2', 'HYB2');
    await db.insertTokenCreation(mysql, createTokenTxTokenId, txId);

    await db.storeTokenInformation(mysql, nanoTokenId, 'NC Token 2', 'NCT2');
    await db.insertTokenCreation(mysql, nanoTokenId, txId);

    // Verify both tokens exist
    let createTokenTxToken = await db.getTokenInformation(mysql, createTokenTxTokenId);
    let nanoToken = await db.getTokenInformation(mysql, nanoTokenId);
    expect(createTokenTxToken).not.toBeNull();
    expect(nanoToken).not.toBeNull();

    // Transaction becomes voided - delete ALL tokens
    const tokensCreated = await db.getTokensCreatedByTx(mysql, txId);
    await db.deleteTokens(mysql, tokensCreated);
    await db.deleteTokenCreationMappings(mysql, tokensCreated);

    // Verify both tokens were deleted
    createTokenTxToken = await db.getTokenInformation(mysql, createTokenTxTokenId);
    nanoToken = await db.getTokenInformation(mysql, nanoTokenId);
    expect(createTokenTxToken).toBeNull();
    expect(nanoToken).toBeNull();

    // Verify all mappings were deleted
    const tokensAfterVoid = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensAfterVoid).toHaveLength(0);
  });

  it('should handle complex scenario - reorg then void', async () => {
    const txId = 'hybrid-tx-003';
    const createTokenTxTokenId = txId;
    const nanoTokenId = 'nano-created-token-003';

    // Create both tokens
    await db.storeTokenInformation(mysql, createTokenTxTokenId, 'Hybrid Token 3', 'HYB3');
    await db.insertTokenCreation(mysql, createTokenTxTokenId, txId);

    await db.storeTokenInformation(mysql, nanoTokenId, 'NC Token 3', 'NCT3');
    await db.insertTokenCreation(mysql, nanoTokenId, txId);

    // First: Reorg happens - nc_execution changes to PENDING
    await db.deleteTokens(mysql, [nanoTokenId]);
    await db.deleteTokenCreationMappings(mysql, [nanoTokenId]);

    // Verify: only CREATE_TOKEN_TX token remains
    let createTokenTxToken = await db.getTokenInformation(mysql, createTokenTxTokenId);
    let nanoToken = await db.getTokenInformation(mysql, nanoTokenId);
    expect(createTokenTxToken).not.toBeNull();
    expect(nanoToken).toBeNull();

    // Then: Transaction becomes voided
    const remainingTokens = await db.getTokensCreatedByTx(mysql, txId);
    await db.deleteTokens(mysql, remainingTokens);
    await db.deleteTokenCreationMappings(mysql, remainingTokens);

    // Verify: all tokens deleted
    createTokenTxToken = await db.getTokenInformation(mysql, createTokenTxTokenId);
    nanoToken = await db.getTokenInformation(mysql, nanoTokenId);
    expect(createTokenTxToken).toBeNull();
    expect(nanoToken).toBeNull();

    const tokensAfterVoid = await db.getTokensCreatedByTx(mysql, txId);
    expect(tokensAfterVoid).toHaveLength(0);
  });
});
