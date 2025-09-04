/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { Connection } from 'mysql2/promise';
import { Interpreter } from 'xstate';
import { getLastSyncedEvent } from '../../../src/db';
import { AddressBalance, AddressBalanceRow, Context, Event } from '../../../src/types';

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

export const validateBalances = async (
  balancesA: AddressBalance[],
  balancesB: Record<string, bigint>,
): Promise<void> => {
  // Create a set of all addresses from both sources
  const allAddresses = new Set([
    ...balancesA.map(b => b.address),
    ...Object.keys(balancesB)
  ]);

  for (const address of allAddresses) {
    const balanceA = balancesA.find(b => b.address === address);
    const balanceB = balancesB[address];
    
    const totalBalanceA = balanceA ? (balanceA.lockedBalance + balanceA.unlockedBalance) : BigInt(0);
    const expectedBalance = balanceB || BigInt(0);

    if (totalBalanceA !== expectedBalance) {
      throw new Error(`Balances are not equal for address: ${address}, expected: ${expectedBalance}, received: ${totalBalanceA}`);
    }
  }
};

export const validateBalanceDistribution = (
  balances: AddressBalance[],
  expectedConfig: {
    balanceDistribution: number[];
    totalAddresses: number;
    tokenId: string;
  }
): void => {
  // Filter balances for the expected token
  const tokenBalances = balances.filter(b => b.tokenId === expectedConfig.tokenId);

  // Check total number of addresses
  if (tokenBalances.length !== expectedConfig.totalAddresses) {
    throw new Error(
      `Expected ${expectedConfig.totalAddresses} addresses, but found ${tokenBalances.length}`
    );
  }

  // Get actual balance amounts
  const actualBalances = tokenBalances
    .map(b => Number(b.lockedBalance + b.unlockedBalance))
    .sort((a, b) => b - a); // Sort descending

  // Sort expected balances descending to match
  const expectedBalances = [...expectedConfig.balanceDistribution].sort((a, b) => b - a);

  // Check if balance distributions match
  for (let i = 0; i < expectedBalances.length; i++) {
    if (actualBalances[i] !== expectedBalances[i]) {
      throw new Error(
        `Balance distribution mismatch at position ${i}: expected ${expectedBalances[i]}, got ${actualBalances[i]}. ` +
        `Expected: [${expectedBalances.join(', ')}], Actual: [${actualBalances.join(', ')}]`
      );
    }
  }
};

export * from './voiding-consistency-checks';

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
