/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Connection as MysqlConnection, RowDataPacket } from 'mysql2/promise';
import { DbTxOutput, EventTxInput } from '../src/types';
import { TxInput, TxOutputWithIndex } from '@wallet-service/common/src/types';
import {
  AddressBalanceRow,
  AddressTableRow,
  AddressTxHistoryRow,
  TokenInformationRow,
  TxOutputRow,
  WalletBalanceRow,
  WalletTxHistoryRow,
} from '../src/types';
import {
  Token,
  AddressTableEntry,
  TokenTableEntry,
  WalletBalanceEntry,
  WalletTableEntry,
  AddressTxHistoryTableEntry
} from './types';
import { isEqual } from 'lodash';

export const XPUBKEY = 'xpub6CsZPtBWMkwxVxyBTKT8AWZcYqzwZ5K2qMkqjFpibMbBZ72JAvLMz7LquJNs4svfTiNYy6GbLo8gqECWsC6hTRt7imnphUFNEMz6VuRSjww';
export const ADDRESSES = [
  'HBCQgVR8Xsyv1BLDjf9NJPK1Hwg4rKUh62',
  'HPDWdurEygcubNMUUnTDUAzngrSXFaqGQc',
  'HEYCNNZZYrimD97AtoRcgcNFzyxtkgtt9Q',
  'HPTtSRrDd4ekU4ZQ2jnSLYayL8hiToE5D4',
  'HTYymKpjyXnz4ssEAnywtwnXnfneZH1Dbh',
  'HUp754aDZ7yKndw2JchXEiMvgzKuXasUmF',
  'HLfGaQoxssGbZ4h9wbLyiCafdE8kPm6Fo4',
  'HV3ox5B1Dai6Jp5EhV8DvUiucc1z3WJHjL',
  'HNWxs2bxgYtzfCpU6cJMGLgmqv7eGupTHr',
  'H9Ef7qteC4vAoVUYx5mvP9jCfmZgU9rSvL',
  'H7hxR75zsPzwfPWbrdkkFbKN2SiL2Lvyuw',
  'HVCa4QJbHB6pkqvNkmQZD2vpmwTYMNdzVo',
  'HBchgf1JLxwJzUg6epckK3YJn6Bq8XJMPV',
  'HVWf61fwoj9Dx15NvWicqXQgGMYVYedSx4',
  'H7PfxBmaqjoBisFRzpizoB9JcYSvoo8D2j',
  'HC1NXVzGcVAd84QMfFngHiKyK2K8SUiTaL',
  'HCqsSDrbs1cfqnF6QMUQkdGYXjEMyt9N3Y',
];

export const createOutput = (
  index: number,
  value: number,
  address: string,
  token = '00',
  timelock: number | null = null,
  locked = false,
  tokenData = 0,
  spentBy = null,
): TxOutputWithIndex => (
  {
    value,
    token,
    locked,
    index,
    decoded: {
      type: 'P2PKH',
      address,
      timelock,
    },
    token_data: tokenData,
    script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
    spent_by: spentBy,
  }
);

export const createEventTxInput = (
  value: number,
  address: string,
  txId: string,
  index: number,
  timelock: number | null | undefined = null,
  tokenData = 0,
): EventTxInput => (
  {
    tx_id: txId,
    index,
    spent_output: {
      value,
      token_data: tokenData,
      script: 'dqkUCEboPJo9txn548FA/NLLaMLsfsSIrA==',
      locked: false,
      decoded: {
        type: 'P2PKH',
        address,
        timelock,
      },
    }
  }
);

export const createInput = (
  value: number,
  address: string,
  txId: string,
  index: number,
  token = '00',
  timelock: number | null | undefined = null,
  tokenData = 0,
): TxInput => (
  {
    value,
    token_data: tokenData,
    script: 'dqkUCEboPJo9txn548FA/NLLaMLsfsSIrA==',
    decoded: {
      type: 'P2PKH',
      address,
      timelock,
    },
    token,
    tx_id: txId,
    index,
  }
);

export const checkUtxoTable = async (
  mysql: MysqlConnection,
  totalResults: number,
  txId?: string,
  index?: number,
  tokenId?: string,
  address?: string,
  value?: number,
  authorities?: number,
  timelock?: number | null,
  heightlock?: number | null,
  locked?: boolean,
  spentBy?: string | null,
  voided = false,
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let [results] = await mysql.query<TxOutputRow[]>('SELECT * FROM `tx_output` WHERE spent_by IS NULL');
  if (results.length !== totalResults) {
    return {
      error: 'checkUtxoTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;

  // now fetch the exact entry
  const baseQuery = `
    SELECT *
      FROM \`tx_output\`
     WHERE \`tx_id\` = ?
       AND \`index\` = ?
       AND \`token_id\` = ?
       AND \`address\` = ?
       AND \`value\` = ?
       AND \`authorities\` = ?
       AND \`locked\` = ?
       AND \`voided\` = ?
       AND \`timelock\``;

  [results] = await mysql.query<TxOutputRow[]>(
    `${baseQuery} ${timelock ? '= ?' : 'IS ?'}
       AND \`heightlock\` ${heightlock ? '= ?' : 'IS ?'}
       AND \`spent_by\` ${spentBy ? '= ?' : 'IS ?'}
    `,
    [txId, index, tokenId, address, value, authorities, locked, voided, timelock, heightlock, spentBy],
  );

  if (results.length !== 1) {
    return {
      error: 'checkUtxoTable query',
      params: { txId, index, tokenId, address, value, authorities, timelock, heightlock, locked, spentBy, voided },
      results,
    };
  }
  return true;
};

export const cleanDatabase = async (mysql: MysqlConnection): Promise<void> => {
  const TABLES = [
    'address',
    'address_balance',
    'address_tx_history',
    'token',
    'tx_proposal',
    'transaction',
    'tx_output',
    'version_data',
    'wallet',
    'wallet_balance',
    'wallet_tx_history',
    'miner',
    'push_devices',
    'sync_metadata',
  ];
  await mysql.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of TABLES) {
    await mysql.query(`DELETE FROM ${table}`);
  }
  await mysql.query('SET FOREIGN_KEY_CHECKS = 1');
};

interface CountRow extends RowDataPacket {
  count: number;
}

export const countTxOutputTable = async (
  mysql: MysqlConnection,
): Promise<number> => {
  const [results] = await mysql.query<CountRow[]>(
    `SELECT COUNT(*) AS count
       FROM \`tx_output\`
      WHERE \`voided\` = FALSE`,
  );

  if (results.length > 0) {
    return results[0].count as number;
  }

  return 0;
};

export const addToAddressTable = async (
  mysql: MysqlConnection,
  entries: AddressTableEntry[],
): Promise<void> => {
  const payload = entries.map((entry) => ([
    entry.address,
    entry.index,
    entry.walletId,
    entry.transactions,
  ]));

  await mysql.query(`
    INSERT INTO \`address\`(\`address\`, \`index\`,
                            \`wallet_id\`, \`transactions\`)
    VALUES ?`,
  [payload]);
};

export const checkAddressTable = async (
  mysql: MysqlConnection,
  totalResults: number,
  address?: string,
  index?: number | null,
  walletId?: string | null,
  transactions?: number,
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let [results] = await mysql.query<AddressTableRow[]>('SELECT * FROM `address`');
  if (results.length !== totalResults) {
    return {
      error: 'checkAddressTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;

  // now fetch the exact entry
  const baseQuery = `
    SELECT *
      FROM \`address\`
     WHERE \`address\` = ?
       AND \`transactions\` = ?
       AND \`index\`
  `;
  const query = `${baseQuery} ${index !== null ? '= ?' : 'IS ?'} AND wallet_id ${walletId ? '= ?' : 'IS ?'}`;
  [results] = await mysql.query<AddressTableRow[]>(
    query,
    [address, transactions, index, walletId],
  );
  if (results.length !== 1) {
    return {
      error: 'checkAddressTable query',
      params: { address, transactions, index, walletId },
      results,
    };
  }
  return true;
};

export const checkAddressBalanceTable = async (
  mysql: MysqlConnection,
  totalResults: number,
  address: string,
  tokenId: string,
  unlocked: number,
  locked: number,
  lockExpires: number | null,
  transactions: number,
  unlockedAuthorities = 0,
  lockedAuthorities = 0,
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let [results] = await mysql.query<AddressBalanceRow[]>(`
    SELECT *
      FROM \`address_balance\`
  `);
  if (results.length !== totalResults) {
    return {
      error: 'checkAddressBalanceTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  // now fetch the exact entry
  const baseQuery = `
    SELECT *
      FROM \`address_balance\`
     WHERE \`address\` = ?
       AND \`token_id\` = ?
       AND \`unlocked_balance\` = ?
       AND \`locked_balance\` = ?
       AND \`transactions\` = ?
       AND \`unlocked_authorities\` = ?
       AND \`locked_authorities\` = ?`;

  [results] = await mysql.query<AddressBalanceRow[]>(
    `${baseQuery} AND timelock_expires ${lockExpires === null ? 'IS' : '='} ?`, [
      address,
      tokenId,
      unlocked,
      locked,
      transactions,
      unlockedAuthorities,
      lockedAuthorities,
      lockExpires,
    ],
  );

  if (results.length !== 1) {
    return {
      error: 'checkAddressBalanceTable query',
      params: { address, tokenId, unlocked, locked, lockExpires, transactions, unlockedAuthorities, lockedAuthorities },
      results,
    };
  }
  return true;
};

export const checkAddressTxHistoryTable = async (
  mysql: MysqlConnection,
  totalResults: number,
  address: string,
  txId: string,
  tokenId: string,
  balance: number,
  timestamp: number,
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let [results] = await mysql.query<AddressTxHistoryRow[]>('SELECT * FROM `address_tx_history`');
  expect(results).toHaveLength(totalResults);
  if (results.length !== totalResults) {
    return {
      error: 'checkAddressTxHistoryTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  // If we expect the table to be empty, we can return now.
  if (totalResults === 0) {
    return true;
  }

  // now fetch the exact entry
  [results] = await mysql.query<AddressTxHistoryRow[]>(
    `SELECT *
       FROM \`address_tx_history\`
      WHERE \`address\` = ?
        AND \`tx_id\` = ?
        AND \`token_id\` = ?
        AND \`balance\` = ?
        AND \`timestamp\` = ?`,
    [
      address,
      txId,
      tokenId,
      balance,
      timestamp,
    ],
  );
  if (results.length !== 1) {
    return {
      error: 'checkAddressTxHistoryTable query',
      params: { address, txId, tokenId, balance, timestamp },
      results,
    };
  }
  return true;
};

export const addToAddressBalanceTable = async (
  mysql: MysqlConnection,
  entries: unknown[][],
): Promise<void> => {
  await mysql.query(`
    INSERT INTO \`address_balance\`(\`address\`, \`token_id\`,
                                    \`unlocked_balance\`, \`locked_balance\`,
                                    \`timelock_expires\`, \`transactions\`,
                                    \`unlocked_authorities\`, \`locked_authorities\`,
                                    \`total_received\`)
    VALUES ?`,
  [entries]);
};

export const addToWalletBalanceTable = async (
  mysql: MysqlConnection,
  entries: WalletBalanceEntry[],
): Promise<void> => {
  const payload = entries.map((entry) => ([
    entry.walletId,
    entry.tokenId,
    entry.unlockedBalance,
    entry.lockedBalance,
    entry.unlockedAuthorities,
    entry.lockedAuthorities,
    entry.timelockExpires,
    entry.transactions,
  ]));

  await mysql.query(`
    INSERT INTO \`wallet_balance\`(\`wallet_id\`, \`token_id\`,
                                   \`unlocked_balance\`, \`locked_balance\`,
                                   \`unlocked_authorities\`, \`locked_authorities\`,
                                   \`timelock_expires\`, \`transactions\`)
    VALUES ?`,
  [payload]);
};

export const addToUtxoTable = async (
  mysql: MysqlConnection,
  entries: DbTxOutput[],
): Promise<void> => {
  const payload = entries.map((entry: DbTxOutput) => ([
    entry.txId,
    entry.index,
    entry.tokenId,
    entry.address,
    entry.value,
    entry.authorities,
    entry.timelock || null,
    entry.heightlock || null,
    entry.locked,
    entry.spentBy || null,
    entry.txProposalId || null,
    entry.txProposalIndex,
    entry.voided || false,
  ]));
  await mysql.query(
    `INSERT INTO \`tx_output\`(
                   \`tx_id\`
                 , \`index\`
                 , \`token_id\`
                 , \`address\`
                 , \`value\`
                 , \`authorities\`
                 , \`timelock\`
                 , \`heightlock\`
                 , \`locked\`
                 , \`spent_by\`
                 , \`tx_proposal\`
                 , \`tx_proposal_index\`
                 , \`voided\`)
     VALUES ?`,
    [payload],
  );
};

export const checkWalletBalanceTable = async (
  mysql: MysqlConnection,
  totalResults: number,
  walletId?: string,
  tokenId?: string,
  unlocked?: number,
  locked?: number,
  lockExpires?: number | null,
  transactions?: number,
  unlockedAuthorities = 0,
  lockedAuthorities = 0,
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let [results] = await mysql.query<WalletBalanceRow[]>(`
    SELECT *
      FROM \`wallet_balance\`
  `);
  expect(results).toHaveLength(totalResults);
  if (results.length !== totalResults) {
    return {
      error: 'checkWalletBalanceTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;

  // now fetch the exact entry
  const baseQuery = `
    SELECT *
      FROM \`wallet_balance\`
     WHERE \`wallet_id\` = ?
       AND \`token_id\` = ?
       AND \`unlocked_balance\` = ?
       AND \`locked_balance\` = ?
       AND \`transactions\` = ?
       AND \`unlocked_authorities\` = ?
       AND \`locked_authorities\` = ?
  `;
  [results] = await mysql.query<WalletBalanceRow[]>(
    `${baseQuery} AND timelock_expires ${lockExpires === null ? 'IS' : '='} ?`,
    [walletId, tokenId, unlocked, locked, transactions, unlockedAuthorities, lockedAuthorities, lockExpires],
  );
  if (results.length !== 1) {
    return {
      error: 'checkWalletBalanceTable query',
      params: { walletId, tokenId, unlocked, locked, lockExpires, transactions, unlockedAuthorities, lockedAuthorities },
      results,
    };
  }
  return true;
};

export const addToWalletTable = async (
  mysql: MysqlConnection,
  entries: WalletTableEntry[],
): Promise<void> => {
  const payload = entries.map((entry) => [
    entry.id,
    entry.xpubkey,
    entry.highestUsedIndex || -1,
    entry.authXpubkey,
    entry.status,
    entry.maxGap,
    entry.createdAt,
    entry.readyAt,
  ]);
  await mysql.query(`
    INSERT INTO \`wallet\`(\`id\`, \`xpubkey\`,
                           \`last_used_address_index\`,
                           \`auth_xpubkey\`,
                           \`status\`, \`max_gap\`,
                           \`created_at\`, \`ready_at\`)
    VALUES ?`,
  [payload]);
};

export const addToTokenTable = async (
  mysql: MysqlConnection,
  entries: TokenTableEntry[],
): Promise<void> => {
  const payload = entries.map((entry) => ([
    entry.id,
    entry.name,
    entry.symbol,
    entry.transactions,
  ]));

  await mysql.query(
    'INSERT INTO `token`(`id`, `name`, `symbol`, `transactions`) VALUES ?',
    [payload],
  );
};

export const checkTokenTable = async (
  mysql: MysqlConnection,
  totalResults: number,
  entries: Token[],
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let [results] = await mysql.query<TokenInformationRow[]>('SELECT * FROM `token`');
  if (results.length !== totalResults) {
    return {
      error: 'checkTokenTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;

  // Fetch the exact entries
  const query = `
    SELECT *
      FROM \`token\`
     WHERE \`id\` IN (?)
  `;
  [results] = await mysql.query<TokenInformationRow[]>(
    query,
    [entries.map((token) => token.tokenId)],
  );

  const resultTokens: Token[] = results.map((result: TokenInformationRow) => ({
    tokenId: result.id,
    tokenSymbol: result.symbol,
    tokenName: result.name,
    transactions: result.transactions,
  }));
  const invalidResults = resultTokens.filter((token: Token) => {
    const entry = entries.find(({ tokenId }) => tokenId === token.tokenId);

    if (!entry) {
      return true;
    }

    // token is a RowDataPacket, so just cast it to an object so we can
    // compare it
    if (!isEqual({ ...token }, entry)) {
      return true;
    }

    return false;
  });

  if (invalidResults.length > 0) {
    return {
      error: 'checkTokenTable query',
      params: entries,
      invalidResults,
    };
  }
  return true;
};

export const checkWalletTxHistoryTable = async (
  mysql: MysqlConnection,
  totalResults: number,
  walletId?: string,
  tokenId?: string,
  txId?: string,
  balance?: number,
  timestamp?: number): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let [results] = await mysql.query<WalletTxHistoryRow[]>('SELECT * FROM `wallet_tx_history`');
  expect(results).toHaveLength(totalResults);
  if (results.length !== totalResults) {
    return {
      error: 'checkWalletTxHistoryTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;

  // now fetch the exact entry
  [results] = await mysql.query<WalletTxHistoryRow[]>(
    `SELECT *
       FROM \`wallet_tx_history\`
      WHERE \`wallet_id\` = ?
        AND \`token_id\` = ?
        AND \`tx_id\` = ?
        AND \`balance\` = ?
        AND \`timestamp\` = ?`,
    [
      walletId,
      tokenId,
      txId,
      balance,
      timestamp,
    ],
  );

  if (results.length !== 1) {
    return {
      error: 'checkWalletTxHistoryTable query',
      params: { walletId, tokenId, txId, balance, timestamp },
      results,
    };
  }
  return true;
};

export const addToAddressTxHistoryTable = async (
  mysql: MysqlConnection,
  entries: AddressTxHistoryTableEntry[],
): Promise<void> => {
  const payload = entries.map((entry) => ([
    entry.address,
    entry.txId,
    entry.tokenId,
    entry.balance,
    entry.timestamp,
    entry.voided || false,
  ]));

  await mysql.query(`
    INSERT INTO \`address_tx_history\`(\`address\`, \`tx_id\`,
                                       \`token_id\`, \`balance\`,
                                       \`timestamp\`, \`voided\`)
    VALUES ?`,
  [payload]);
};
