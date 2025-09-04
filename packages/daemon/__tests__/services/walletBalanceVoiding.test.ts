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
} from '../../src/db';
import { voidTx } from '../../src/services';
import {
  cleanDatabase,
  createOutput,
  createInput,
  createEventTxInput,
} from '../utils';
import { EventTxInput } from '../../src/types';

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
  await mysql.destroy();
});

beforeEach(async () => {
  await cleanDatabase(mysql);
});

// Helper function to create a wallet and addresses
const setupWallet = async (walletId: string, addresses: string[]) => {
  const now = Math.floor(Date.now() / 1000); // Unix timestamp
  // Create wallet
  await mysql.query(
    `INSERT INTO \`wallet\` (id, xpubkey, auth_xpubkey, status, max_gap, created_at, ready_at)
     VALUES (?, 'xpub123', 'xpub456', 'ready', 20, ?, ?)`,
    [walletId, now, now]
  );

  // Add addresses to the wallet
  const addressEntries = addresses.map((address, index) => [address, index, walletId, 1]);
  await mysql.query(
    `INSERT INTO \`address\` (address, \`index\`, wallet_id, transactions)
     VALUES ?`,
    [addressEntries]
  );
};

// Helper function to get wallet balance
const getWalletBalance = async (walletId: string, tokenId: string) => {
  const [results] = await mysql.query(
    `SELECT * FROM \`wallet_balance\` WHERE \`wallet_id\` = ? AND \`token_id\` = ?`,
    [walletId, tokenId]
  ) as [any[], any];
  return results[0] || null;
};

// Helper function to manually insert wallet balance (simulating what should happen)
const insertWalletBalance = async (walletId: string, tokenId: string, balance: bigint, transactions: number) => {
  await mysql.query(
    `INSERT INTO \`wallet_balance\` (wallet_id, token_id, unlocked_balance, locked_balance,
                                   unlocked_authorities, locked_authorities, total_received,
                                   transactions, timelock_expires)
     VALUES (?, ?, ?, 0, 0, 0, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE
       unlocked_balance = unlocked_balance + ?,
       total_received = total_received + ?,
       transactions = transactions + ?`,
    [walletId, tokenId, balance, balance, transactions, balance, balance, transactions]
  );
};

// Helper function to get wallet transaction history count
const getWalletTxHistoryCount = async (walletId: string, txId: string) => {
  const [results] = await mysql.query(
    `SELECT COUNT(*) as count FROM \`wallet_tx_history\` WHERE \`wallet_id\` = ? AND \`tx_id\` = ?`,
    [walletId, txId]
  ) as [any[], any];
  return results[0].count;
};

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
    await setupWallet(walletId, [address]);

    // Create transaction A that creates an output to our wallet address
    await addOrUpdateTx(mysql, txIdA, 0, 1, 1, 100);
    const outputA = createOutput(0, initialValue, address, tokenId);
    await addUtxos(mysql, txIdA, [outputA], null);

    // Manually insert wallet balance (simulating what updateWalletTablesWithTx would do)
    await insertWalletBalance(walletId, tokenId, initialValue, 1);

    // Also insert into wallet_tx_history
    await mysql.query(
      `INSERT INTO \`wallet_tx_history\` (wallet_id, token_id, tx_id, balance, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      [walletId, tokenId, txIdA, initialValue, 100]
    );

    // Verify initial wallet balance
    let walletBalance = await getWalletBalance(walletId, tokenId);
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
    await insertWalletBalance(walletId, tokenId, 0n, 1);

    // Add to wallet_tx_history
    await mysql.query(
      `INSERT INTO \`wallet_tx_history\` (wallet_id, token_id, tx_id, balance, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      [walletId, tokenId, txIdB, 0, 101]
    );

    // Verify wallet balance after transaction B
    walletBalance = await getWalletBalance(walletId, tokenId);
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

    await voidTx(mysql, txIdB, inputs, outputs, [tokenId], []);

    // CRITICAL BUG: Check wallet balance after voiding
    walletBalance = await getWalletBalance(walletId, tokenId);
    expect(walletBalance).not.toBeNull();

    // This will FAIL because wallet balances are not updated during voiding
    // The transaction count should decrease from 2 to 1
    expect(walletBalance.transactions).toBe(1); // Should be back to 1 transaction

    // Check if wallet_tx_history was cleaned up
    const historyCount = await getWalletTxHistoryCount(walletId, txIdB);
    // This will FAIL because wallet_tx_history is not cleaned up during voiding
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
    await setupWallet(wallet1Id, [address1]);
    await setupWallet(wallet2Id, [address2]);

    // Simulate wallet1 already having some balance
    await insertWalletBalance(wallet1Id, tokenId, 200n, 1);

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
    await insertWalletBalance(wallet2Id, tokenId, amount, 1);

    // Add wallet_tx_history entries
    await mysql.query(
      `INSERT INTO \`wallet_tx_history\` (wallet_id, token_id, tx_id, balance, timestamp)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      [wallet1Id, tokenId, txId, -amount, 100, wallet2Id, tokenId, txId, amount, 100]
    );

    // Verify wallet balances before voiding
    let wallet1Balance = await getWalletBalance(wallet1Id, tokenId);
    let wallet2Balance = await getWalletBalance(wallet2Id, tokenId);

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

    await voidTx(mysql, txId, inputs, voidOutputs, [tokenId], []);

    // Check wallet balances after voiding
    wallet1Balance = await getWalletBalance(wallet1Id, tokenId);
    wallet2Balance = await getWalletBalance(wallet2Id, tokenId);

    // These assertions will FAIL because wallet balances are not updated during voiding

    // Wallet1 should have its balance restored (50 + 150 = 200)
    expect(BigInt(wallet1Balance.unlocked_balance)).toBe(200n);
    expect(wallet1Balance.transactions).toBe(1); // Should decrease back to 1

    // Wallet2 should have its balance reduced to 0
    if (wallet2Balance) {
      expect(BigInt(wallet2Balance.unlocked_balance)).toBe(0n);
      expect(wallet2Balance.transactions).toBe(0); // Should be 0 after voiding
    }

    // Check wallet_tx_history cleanup
    const wallet1HistoryCount = await getWalletTxHistoryCount(wallet1Id, txId);
    const wallet2HistoryCount = await getWalletTxHistoryCount(wallet2Id, txId);

    // These will FAIL because wallet_tx_history is not cleaned up
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
    await setupWallet(walletId, [address]);

    // Create transaction
    await addOrUpdateTx(mysql, txId, 0, 1, 1, 100);
    const output = createOutput(0, value, address, tokenId);
    await addUtxos(mysql, txId, [output], null);

    // Simulate wallet balance update
    await insertWalletBalance(walletId, tokenId, value, 1);
    await mysql.query(
      `INSERT INTO \`wallet_tx_history\` (wallet_id, token_id, tx_id, balance, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      [walletId, tokenId, txId, value, 100]
    );

    // Verify wallet balance exists
    let walletBalance = await getWalletBalance(walletId, tokenId);
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

    await voidTx(mysql, txId, inputs, outputs, [tokenId], []);

    // Check wallet balance after voiding
    walletBalance = await getWalletBalance(walletId, tokenId);

    // This WILL FAIL because wallet balances are not updated during voiding
    if (walletBalance) {
      expect(BigInt(walletBalance.unlocked_balance)).toBe(0n); // Should be 0 after voiding
      expect(walletBalance.transactions).toBe(0); // Should be 0 after voiding
    }

    // Check wallet_tx_history cleanup
    const historyCount = await getWalletTxHistoryCount(walletId, txId);
    expect(historyCount).toBe(0); // Should be 0 after voiding
  });
});
