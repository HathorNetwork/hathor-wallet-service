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
import { BACKFILL_PUBLIC_ADDRESS_TABLES_SQL, runSqlScript } from '../../utils';

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
    'public_address_tx_history',
    'public_address_tokens',
    'miner',
    'sync_metadata',
    'token',
    'token_creation',
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
  
  // Ensure all changes are committed and flushed
  await mysql.query('COMMIT');
  await mysql.query('FLUSH TABLES');
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
    unlockedShieldedBalance: BigInt(result.unlocked_shielded_balance),
    lockedShieldedBalance: BigInt(result.locked_shielded_balance),
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

const DEFAULT_TRANSITION_TIMEOUT_MS = 60000; // 60 seconds

export async function transitionUntilEvent(
  mysql: Connection,
  machine: Interpreter<Context, any, Event>,
  eventId: number,
  timeoutMs: number = DEFAULT_TRANSITION_TIMEOUT_MS
) {
  return await new Promise<void>((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        machine.stop();
        reject(new Error(`transitionUntilEvent timed out after ${timeoutMs}ms waiting for event ${eventId}`));
      }
    }, timeoutMs);

    machine.onTransition(async (state) => {
      if (resolved) return;

      try {
        if (state.matches('CONNECTED.idle')) {
          const lastSyncedEvent = await getLastSyncedEvent(mysql);
          if (lastSyncedEvent?.last_event_id === eventId) {
            resolved = true;
            clearTimeout(timeout);
            machine.stop();
            resolve();
          }
        }
      } catch (error) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          machine.stop();
          reject(error);
        }
      }
    });

    machine.start();
  });
}


export * from './voiding-consistency-checks';

const publicTablesSnapshot = async (mysql: Connection) => {
  const [history] = await mysql.query(
    'SELECT * FROM `public_address_tx_history` ORDER BY `address`, `token_id`, `timestamp`, `tx_id`',
  );
  const [tokens] = await mysql.query(
    'SELECT * FROM `public_address_tokens` ORDER BY `address`, `token_id`',
  );
  return { history, tokens };
};

/**
 * Check the public address tables after a sync with no shielded outputs:
 * their counters agree with their history, no voided transaction has rows,
 * the history matches `address_tx_history` row for row, and the backfill
 * rebuilds both tables exactly.
 */
export const validatePublicAddressTables = async (mysql: Connection): Promise<void> => {
  const [counterMismatches] = await mysql.query(
    `SELECT p.\`address\`, p.\`token_id\`, p.\`transactions\`, h.\`n\`
       FROM \`public_address_tokens\` p
       LEFT JOIN (SELECT \`address\`, \`token_id\`, COUNT(*) AS \`n\`, SUM(\`has_shielded\`) AS \`s\`,
                         MAX(\`timestamp\`) AS \`ts\`
                    FROM \`public_address_tx_history\` GROUP BY \`address\`, \`token_id\`) h
         ON h.\`address\` = p.\`address\` AND h.\`token_id\` = p.\`token_id\`
      WHERE h.\`n\` IS NULL OR h.\`n\` <> p.\`transactions\`
         OR h.\`s\` <> p.\`shielded_transactions\` OR h.\`ts\` <> p.\`last_activity\``,
  );
  expect(counterMismatches).toEqual([]);

  const [uncounted] = await mysql.query(
    `SELECT DISTINCT h.\`address\`, h.\`token_id\`
       FROM \`public_address_tx_history\` h
       LEFT JOIN \`public_address_tokens\` p ON p.\`address\` = h.\`address\` AND p.\`token_id\` = h.\`token_id\`
      WHERE p.\`address\` IS NULL`,
  );
  expect(uncounted).toEqual([]);

  const [voided] = await mysql.query(
    `SELECT h.\`tx_id\`
       FROM \`public_address_tx_history\` h
       LEFT JOIN \`transaction\` t ON t.\`tx_id\` = h.\`tx_id\`
      WHERE t.\`tx_id\` IS NULL OR t.\`voided\` = TRUE`,
  );
  expect(voided).toEqual([]);

  const [publicRows] = await mysql.query(
    `SELECT \`address\`, \`token_id\`, \`tx_id\`, \`timestamp\`, \`balance\`
       FROM \`public_address_tx_history\` ORDER BY \`address\`, \`token_id\`, \`tx_id\``,
  );
  const [historyRows] = await mysql.query(
    `SELECT \`address\`, \`token_id\`, \`tx_id\`, \`timestamp\`, \`balance\`
       FROM \`address_tx_history\` ORDER BY \`address\`, \`token_id\`, \`tx_id\``,
  );
  expect(publicRows).toEqual(historyRows);

  const synced = await publicTablesSnapshot(mysql);
  await mysql.query('DELETE FROM `public_address_tx_history`');
  await mysql.query('DELETE FROM `public_address_tokens`');
  await runSqlScript(mysql, BACKFILL_PUBLIC_ADDRESS_TABLES_SQL, { batch_size: 3 });
  expect(await publicTablesSnapshot(mysql)).toEqual(synced);
};
