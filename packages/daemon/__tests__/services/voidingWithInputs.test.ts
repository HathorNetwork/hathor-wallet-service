/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @jest-environment node
 */

import { Connection } from 'mysql2/promise';
import {
  getDbConnection,
  addOrUpdateTx,
  addUtxos,
  updateTxOutputSpentBy,
  getTxOutput,
  unspendUtxos,
} from '../../src/db';
import { voidTx } from '../../src/services';
import {
  cleanDatabase,
  checkUtxoTable,
  createOutput,
  createInput,
  createEventTxInput,
} from '../utils';
import { DbTxOutput } from '../../src/types';

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

afterAll(async () => {
  if (mysql) {
    await mysql.destroy();
  }
});

beforeEach(async () => {
  await cleanDatabase(mysql);
  // Add a small delay to ensure database operations complete
  await new Promise(resolve => setTimeout(resolve, 10));
});

describe('voidTransaction with input unspending', () => {
  it('should unspent inputs when voiding a transaction', async () => {
    expect.hasAssertions();

    // Create transaction A that creates an output
    const txIdA = 'tx-a';
    const addressA = 'address-a';
    const tokenId = '00';
    const outputValue = 100n;

    await addOrUpdateTx(mysql, txIdA, 0, 1, 1, 100);

    // Add output from transaction A
    const outputA = createOutput(0, outputValue, addressA, tokenId);
    await addUtxos(mysql, txIdA, [outputA], null);

    // Ensure database operations complete
    await new Promise(resolve => setTimeout(resolve, 10));

    // Verify the UTXO is unspent
    let utxo = await getTxOutput(mysql, txIdA, 0, true);
    expect(utxo).not.toBeNull();
    expect(utxo!.spentBy).toBeNull();

    // Create transaction B that spends the output from transaction A
    const txIdB = 'tx-b';
    const addressB = 'address-b';

    await addOrUpdateTx(mysql, txIdB, 0, 1, 1, 101);

    // Mark the output from A as spent by B
    const inputB = createInput(outputValue, addressA, txIdA, 0, tokenId);
    await updateTxOutputSpentBy(mysql, [inputB], txIdB);

    // Ensure database operations complete
    await new Promise(resolve => setTimeout(resolve, 10));

    // Verify the UTXO is now spent
    utxo = await getTxOutput(mysql, txIdA, 0, false);
    expect(utxo).not.toBeNull();
    expect(utxo!.spentBy).toBe(txIdB);

    // Add output from transaction B
    const outputB = createOutput(0, outputValue, addressB, tokenId);
    await addUtxos(mysql, txIdB, [outputB], null);

    // Ensure database operations complete before voiding
    await new Promise(resolve => setTimeout(resolve, 10));

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

    await voidTx(mysql, txIdB, inputs, outputs, [tokenId], []);

    // CRITICAL: The voidTx function should unspent the inputs
    // This test should PASS because unspending is now implemented in voidTx

    // Check if the UTXO from transaction A is unspent again
    utxo = await getTxOutput(mysql, txIdA, 0, true);
    expect(utxo).not.toBeNull();
    expect(utxo!.spentBy).toBeNull(); // This should pass - it should be null
  });

  it('should unspent multiple inputs when voiding a transaction with multiple inputs', async () => {
    expect.hasAssertions();

    // Create transactions A and B that create outputs
    const txIdA = 'tx-a';
    const txIdB = 'tx-b';
    const txIdC = 'tx-c'; // The transaction we'll void
    const address1 = 'address-1';
    const address2 = 'address-2';
    const address3 = 'address-3';
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
    expect(utxoA!.spentBy).toBeNull();
    expect(utxoB!.spentBy).toBeNull();

    // Create transaction C that spends both outputs
    await addOrUpdateTx(mysql, txIdC, 0, 1, 1, 102);

    const inputC1 = createInput(50n, address1, txIdA, 0, tokenId);
    const inputC2 = createInput(75n, address2, txIdB, 0, tokenId);
    await updateTxOutputSpentBy(mysql, [inputC1, inputC2], txIdC);

    // Verify both UTXOs are now spent by C
    utxoA = await getTxOutput(mysql, txIdA, 0, false);
    utxoB = await getTxOutput(mysql, txIdB, 0, false);
    expect(utxoA!.spentBy).toBe(txIdC);
    expect(utxoB!.spentBy).toBe(txIdC);

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

    await voidTx(mysql, txIdC, inputs, outputs, [tokenId], []);

    // Check if both UTXOs from transactions A and B are unspent again
    utxoA = await getTxOutput(mysql, txIdA, 0, true);
    utxoB = await getTxOutput(mysql, txIdB, 0, true);

    // These assertions should PASS because unspending is now implemented
    expect(utxoA).not.toBeNull();
    expect(utxoA!.spentBy).toBeNull(); // Should pass - should be null
    expect(utxoB).not.toBeNull();
    expect(utxoB!.spentBy).toBeNull(); // Should pass - should be null
  });

  it('should handle voiding a transaction that spends already voided outputs', async () => {
    expect.hasAssertions();

    // Create transaction A that creates an output
    const txIdA = 'tx-a';
    const txIdB = 'tx-b'; // Will be voided first
    const txIdC = 'tx-c'; // Will be voided second
    const address1 = 'address-1';
    const address2 = 'address-2';
    const address3 = 'address-3';
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

    // Transaction C spends B's output
    await addOrUpdateTx(mysql, txIdC, 0, 1, 1, 102);
    const inputC = createInput(100n, address2, txIdB, 0, tokenId);
    await updateTxOutputSpentBy(mysql, [inputC], txIdC);
    const outputC = createOutput(0, 100n, address3, tokenId);
    await addUtxos(mysql, txIdC, [outputC], null);

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
      []
    );

    // B's output should be unspent now (and it will be with the fix)
    let utxoB = await getTxOutput(mysql, txIdB, 0, true);
    expect(utxoB).not.toBeNull();
    expect(utxoB!.spentBy).toBeNull(); // Should pass - should be null

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
      []
    );

    // A's output should be unspent now
    let utxoA = await getTxOutput(mysql, txIdA, 0, true);
    expect(utxoA).not.toBeNull();
    expect(utxoA!.spentBy).toBeNull(); // Should pass - should be null
  });

  it('should handle voiding when one input is already spent by another transaction', async () => {
    expect.hasAssertions();

    // This tests an edge case where we try to void a transaction
    // but one of its inputs was already spent by another transaction
    // (which shouldn't happen in practice but we should handle gracefully)

    const txIdA = 'tx-a';
    const txIdB = 'tx-b';
    const txIdC = 'tx-c'; // Will try to spend A's output after B already spent it
    const address1 = 'address-1';
    const address2 = 'address-2';
    const tokenId = '00';

    // Create UTXO
    await addOrUpdateTx(mysql, txIdA, 0, 1, 1, 100);
    const outputA = createOutput(0, 100n, address1, tokenId);
    await addUtxos(mysql, txIdA, [outputA], null);

    // Transaction B spends it
    await addOrUpdateTx(mysql, txIdB, 0, 1, 1, 101);
    const inputB = createInput(100n, address1, txIdA, 0, tokenId);
    await updateTxOutputSpentBy(mysql, [inputB], txIdB);

    // For this test, we simulate that transaction C also tried to spend it
    // (in reality this would be a double-spend, but we're testing edge cases)
    await addOrUpdateTx(mysql, txIdC, 0, 1, 1, 102);

    // Add output for transaction C
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

    await voidTx(mysql, txIdC, inputs, outputs, [tokenId], []);

    // The UTXO should still be spent by B, not unspent
    const utxo = await getTxOutput(mysql, txIdA, 0, false);
    expect(utxo).not.toBeNull();
    expect(utxo!.spentBy).toBe(txIdB); // Should remain spent by B
  });

  it('should correctly unspent inputs with different token types', async () => {
    expect.hasAssertions();

    const txIdA = 'tx-a';
    const txIdB = 'tx-b';
    const address1 = 'address-1';
    const address2 = 'address-2';
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

    await voidTx(mysql, txIdB, inputs, outputs, [hathorToken, customToken], []);

    // Both UTXOs should be unspent
    const utxo1 = await getTxOutput(mysql, txIdA, 0, true);
    const utxo2 = await getTxOutput(mysql, txIdA, 1, true);

    // These should pass with the implementation
    expect(utxo1).not.toBeNull();
    expect(utxo1!.spentBy).toBeNull();
    expect(utxo2).not.toBeNull();
    expect(utxo2!.spentBy).toBeNull();
  });

  it('should verify the complete flow with balance checks', async () => {
    expect.hasAssertions();

    // Complete integration test
    const txIdA = 'tx-a';
    const txIdB = 'tx-b';
    const address1 = 'address-1';
    const address2 = 'address-2';
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
    expect(spentUtxo!.spentBy).toBe(txIdB);

    // Void the spending transaction
    const inputs = [createEventTxInput(value, address1, txIdA, 0)];
    const outputs = [{
      value,
      locked: false,
      decoded: { type: 'P2PKH' as const, address: address2, timelock: null },
      token_data: 0,
      script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
    }];

    await voidTx(mysql, txIdB, inputs, outputs, [tokenId], []);

    // Verify the original UTXO is unspent again
    const unspentUtxo = await getTxOutput(mysql, txIdA, 0, true);
    expect(unspentUtxo).not.toBeNull();
    expect(unspentUtxo!.spentBy).toBeNull(); // This should pass

    // Also verify that B's outputs are marked as voided
    const voidedUtxo = await getTxOutput(mysql, txIdB, 0, false);
    expect(voidedUtxo).toBeNull(); // Should be null because it's voided
  });
});

describe('unspentTxOutputs function', () => {
  it('should correctly unspent transaction outputs', async () => {
    expect.hasAssertions();

    // This tests the unspentTxOutputs function directly
    const txIdA = 'tx-a';
    const txIdB = 'tx-b';
    const txIdC = 'tx-c';
    const spendingTx = 'spending-tx';
    const address = 'test-address';
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
    expect(utxoA!.spentBy).toBe(spendingTx);
    expect(utxoB!.spentBy).toBe(spendingTx);
    expect(utxoC!.spentBy).toBe(spendingTx);

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
    expect(utxoA!.spentBy).toBeNull();
    expect(utxoB).not.toBeNull();
    expect(utxoB!.spentBy).toBeNull();
    expect(utxoC).not.toBeNull();
    expect(utxoC!.spentBy).toBeNull();
  });
});
