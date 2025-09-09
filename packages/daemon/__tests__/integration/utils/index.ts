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
  const expectedAddresses = new Set(Object.keys(balancesB));

  // Check for unexpected addresses with non-zero balances
  for (const balance of balancesA) {
    const totalBalance = balance.lockedBalance + balance.unlockedBalance;

    if (!expectedAddresses.has(balance.address) && totalBalance !== BigInt(0)) {
      throw new Error(`Unexpected address with non-zero balance: ${balance.address}, balance: ${totalBalance}`);
    }
  }

  // Validate all expected addresses
  for (const address of expectedAddresses) {
    const balanceA = balancesA.find(b => b.address === address);
    const expectedBalance = balancesB[address];

    const totalBalanceA = balanceA ? (balanceA.lockedBalance + balanceA.unlockedBalance) : BigInt(0);

    if (totalBalanceA !== expectedBalance) {
      throw new Error(`Balances are not equal for address: ${address}, expected: ${expectedBalance}, received: ${totalBalanceA}`);
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

export * from './voiding-consistency-checks';
