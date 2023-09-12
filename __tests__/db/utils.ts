import { Connection as MysqlConnection, RowDataPacket } from 'mysql2/promise';
import { TxInput, TxOutputWithIndex } from '../../src/types';

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
  ];
  await mysql.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of TABLES) {
    await mysql.query(`DELETE FROM ${table}`);
  }
  await mysql.query('SET FOREIGN_KEY_CHECKS = 1');
};

export const createOutput = (
  index: number,
  value: number,
  address: string,
  token = '00',
  timelock: number | null = null,
  locked = false,
  tokenData = 0,
  spentBy = null): TxOutputWithIndex => (
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
  let [results] = await mysql.query('SELECT * FROM `tx_output` WHERE spent_by IS NULL');
  // @ts-ignore
  if (results.length !== totalResults) {
    return {
      error: 'checkUtxoTable total results',
      expected: totalResults,
      // @ts-ignore
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

  [results] = await mysql.query(
    `${baseQuery} ${timelock ? '= ?' : 'IS ?'}
       AND \`heightlock\` ${heightlock ? '= ?' : 'IS ?'}
       AND \`spent_by\` ${spentBy ? '= ?' : 'IS ?'}
    `,
    [txId, index, tokenId, address, value, authorities, locked, voided, timelock, heightlock, spentBy],
  );
  // @ts-ignore
  if (results.length !== 1) {
    return {
      error: 'checkUtxoTable query',
      params: { txId, index, tokenId, address, value, authorities, timelock, heightlock, locked, spentBy, voided },
      results,
    };
  }
  return true;
};

export const createInput = (
  value: number,
  address: string,
  txId: string,
  index: number,
  token = '00',
  timelock = null,
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

  // @ts-ignore
  if (results.length > 0) {
    return results[0].count as number;
  }

  return 0;
};
