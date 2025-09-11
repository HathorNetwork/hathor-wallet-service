/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { Connection } from 'mysql2/promise';
import { Interpreter } from 'xstate';
import { getLastSyncedEvent } from '../../../src/db';
import { AddressBalance, AddressBalanceRow, Context, Event, WalletBalanceRow } from '../../../src/types';

export interface WalletBalance {
  walletId: string;
  tokenId: string;
  unlockedBalance: bigint;
  lockedBalance: bigint;
  unlockedAuthorities: number;
  lockedAuthorities: number;
  timelockExpires: number | null;
  transactions: number;
  totalReceived: bigint;
}

export const cleanDatabase = async (mysql: Connection): Promise<void> => {
  const TABLES = [
    'address',
    'address_balance',
    'address_tx_history',
    'miner',
    'sync_metadata',
    'token',
    'transaction',
    'tx_output',
    'tx_proposal',
    'version_data',
    'wallet',
    'wallet_balance',
    'wallet_tx_history',
    'push_devices',
  ];
  await mysql.query('SET FOREIGN_KEY_CHECKS = 0');

  for (const table of TABLES) {
    await mysql.query(`DELETE FROM ${table}`);
  }

  await mysql.query('SET FOREIGN_KEY_CHECKS = 1');
};

export const fetchAddressBalances = async (
  mysql: Connection
): Promise<AddressBalance[]> => {
  const [results] = await mysql.query<AddressBalanceRow[]>(
    `SELECT *
       FROM \`address_balance\`
   ORDER BY \`address\`, \`token_id\``,
  );

  return results.map((result): AddressBalance => ({
    address: result.address as string,
    tokenId: result.token_id as string,
    unlockedBalance: BigInt(result.unlocked_balance),
    lockedBalance: BigInt(result.locked_balance),
    lockedAuthorities: result.locked_authorities as number,
    unlockedAuthorities: result.unlocked_authorities as number,
    timelockExpires: result.timelock_expires as number,
    transactions: result.transactions as number,
  }));
};

export const fetchWalletBalances = async (
  mysql: Connection
): Promise<WalletBalance[]> => {
  const [results] = await mysql.query<WalletBalanceRow[]>(
    `SELECT *
       FROM \`wallet_balance\`
   ORDER BY \`wallet_id\`, \`token_id\``,
  );

  return results.map((result): WalletBalance => ({
    walletId: result.wallet_id as string,
    tokenId: result.token_id as string,
    unlockedBalance: BigInt(result.unlocked_balance),
    lockedBalance: BigInt(result.locked_balance),
    unlockedAuthorities: result.unlocked_authorities as number,
    lockedAuthorities: result.locked_authorities as number,
    timelockExpires: result.timelock_expires as number | null,
    transactions: result.transactions as number,
    totalReceived: BigInt(result.total_received),
  }));
};

export const validateBalances = async (
  balancesA: AddressBalance[],
  expectedBalances: Record<string, { 
    unlockedBalance: bigint; 
    lockedBalance: bigint; 
    authorities?: { locked: number; unlocked: number } 
  }>,
): Promise<void> => {
  const expectedAddressTokenKeys = new Set(Object.keys(expectedBalances));

  // Check for unexpected addresses with non-zero balances or authorities
  for (const balance of balancesA) {
    const addressTokenKey = `${balance.address}:${balance.tokenId}`;
    const totalBalance = balance.lockedBalance + balance.unlockedBalance;
    const totalAuthorities = balance.lockedAuthorities + balance.unlockedAuthorities;

    if (!expectedAddressTokenKeys.has(addressTokenKey) && (totalBalance !== BigInt(0) || totalAuthorities !== 0)) {
      throw new Error(`Unexpected address:token with non-zero balance or authorities: ${addressTokenKey}, balance: ${totalBalance}, authorities: ${totalAuthorities}`);
    }
  }

  // Validate all expected addresses
  for (const addressTokenKey of expectedAddressTokenKeys) {
    const [address, tokenId] = addressTokenKey.split(':');
    const balanceA = balancesA.find(b => b.address === address && b.tokenId === tokenId);
    const expected = expectedBalances[addressTokenKey];

    const actualUnlockedBalance = balanceA ? balanceA.unlockedBalance : BigInt(0);
    const actualLockedBalance = balanceA ? balanceA.lockedBalance : BigInt(0);

    if (actualUnlockedBalance !== expected.unlockedBalance) {
      throw new Error(`Unlocked balance mismatch for address:token ${addressTokenKey}, expected: ${expected.unlockedBalance}, received: ${actualUnlockedBalance}`);
    }

    if (actualLockedBalance !== expected.lockedBalance) {
      throw new Error(`Locked balance mismatch for address:token ${addressTokenKey}, expected: ${expected.lockedBalance}, received: ${actualLockedBalance}`);
    }

    // Validate authorities if specified
    if (expected.authorities && balanceA) {
      if (balanceA.lockedAuthorities !== expected.authorities.locked) {
        throw new Error(`Locked authorities mismatch for address:token ${addressTokenKey}, expected: ${expected.authorities.locked}, received: ${balanceA.lockedAuthorities}`);
      }
      if (balanceA.unlockedAuthorities !== expected.authorities.unlocked) {
        throw new Error(`Unlocked authorities mismatch for address:token ${addressTokenKey}, expected: ${expected.authorities.unlocked}, received: ${balanceA.unlockedAuthorities}`);
      }
    }
  }
};

export const validateWalletBalances = async (
  walletBalances: WalletBalance[],
  expectedWalletBalances: Record<string, { 
    unlockedBalance: bigint; 
    lockedBalance: bigint; 
    authorities?: { locked: number; unlocked: number } 
  }>,
): Promise<void> => {
  for (const [walletTokenKey, expected] of Object.entries(expectedWalletBalances)) {
    const [walletId, tokenId] = walletTokenKey.split(':');
    
    const walletBalance = walletBalances.find(
      b => b.walletId === walletId && b.tokenId === tokenId
    );

    const actualUnlockedBalance = walletBalance ? walletBalance.unlockedBalance : BigInt(0);
    const actualLockedBalance = walletBalance ? walletBalance.lockedBalance : BigInt(0);

    if (actualUnlockedBalance !== expected.unlockedBalance) {
      throw new Error(
        `Wallet unlocked balance mismatch for wallet ${walletId} token ${tokenId}: expected ${expected.unlockedBalance}, received ${actualUnlockedBalance}`
      );
    }

    if (actualLockedBalance !== expected.lockedBalance) {
      throw new Error(
        `Wallet locked balance mismatch for wallet ${walletId} token ${tokenId}: expected ${expected.lockedBalance}, received ${actualLockedBalance}`
      );
    }

    // Validate authorities if specified
    if (expected.authorities && walletBalance) {
      if (walletBalance.lockedAuthorities !== expected.authorities.locked) {
        throw new Error(`Wallet locked authorities mismatch for wallet ${walletId} token ${tokenId}: expected ${expected.authorities.locked}, received ${walletBalance.lockedAuthorities}`);
      }
      if (walletBalance.unlockedAuthorities !== expected.authorities.unlocked) {
        throw new Error(`Wallet unlocked authorities mismatch for wallet ${walletId} token ${tokenId}: expected ${expected.authorities.unlocked}, received ${walletBalance.unlockedAuthorities}`);
      }
    }
  }
};

export async function transitionUntilEvent(mysql: Connection, machine: Interpreter<Context, any, Event>, eventId: number) {
  return await new Promise<void>((resolve) => {
    machine.onTransition(async (state) => {
      if (state.matches('CONNECTED.idle')) {
        const lastSyncedEvent = await getLastSyncedEvent(mysql);
        if (lastSyncedEvent?.last_event_id === eventId) {
          machine.stop();

          resolve();
        }
      }
    });

    machine.start();
  });
}

export const initializeWallet = async (mysql: Connection): Promise<void> => {
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

export * from './voiding-consistency-checks';
