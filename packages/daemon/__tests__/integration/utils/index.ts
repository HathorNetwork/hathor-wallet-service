/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { Connection } from 'mysql2/promise';
import { AddressBalance, AddressBalanceRow } from '../../../src/types';

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
    unlockedBalance: result.unlocked_balance as number,
    lockedBalance: result.locked_balance as number,
    lockedAuthorities: result.locked_authorities as number,
    unlockedAuthorities: result.unlocked_authorities as number,
    timelockExpires: result.timelock_expires as number,
    transactions: result.transactions as number,
  }));
};

export const validateBalances = async (
  balancesA: AddressBalance[],
  balancesB: { string: number },
): Promise<void> => {
  const length = Math.max(balancesA.length, Object.keys(balancesB).length);

  for (let i = 0; i < length; i++) {
    const balanceA = balancesA[i];
    const address = balanceA.address;
    // @ts-ignore
    const balanceB = balancesB[address];
    const totalBalanceA = balanceA.lockedBalance + balanceA.unlockedBalance;

    if (totalBalanceA !== balanceB) {
      console.log(totalBalanceA);
      console.log(balanceB);
      throw new Error(`Balances are not equal for address: ${address}, expected: ${balanceB}, received: ${totalBalanceA}`);
    }
  }
};
