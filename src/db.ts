/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
 import mysql from 'mysql2/promise';
 import { TxOutputWithIndex, TxInput, DbTxOutput } from './types';
 import { isAuthority } from './utils';

/**
 * Get a database connection.
 *
 * @returns The database connection
 */
export const getDbConnection = () => (
  mysql.createConnection({
    host: process.env.DB_ENDPOINT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    password: process.env.DB_PASS,
  })
);

/**
 * Add a tx to the transaction table.
 *
 * @remarks
 * This method adds a transaction to the transaction table
 *
 * @param mysql - Database connection
 * @param txId - Transaction id
 * @param timestamp - The transaction timestamp
 * @param version - The transaction version
 * @param weight - the transaction weight
 */
export const addOrUpdateTx = async (
  mysql: any,
  txId: string,
  height: number,
  timestamp: number,
  version: number,
  weight: number,
): Promise<void> => {
  const entries = [[txId, height, timestamp, version, weight]];

  await mysql.query(
    `INSERT INTO \`transaction\` (tx_id, height, timestamp, version, weight)
     VALUES ?
         ON DUPLICATE KEY UPDATE height = ?`,
    [entries, height],
  );
};

/**
 * Add a tx outputs to the utxo table.
 *
 * @remarks
 * This function receives a list of outputs and supposes they're all from the same block
 * or transaction. So if heighlock is set, it'll be set to all outputs.
 *
 * @param mysql - Database connection
 * @param txId - Transaction id
 * @param outputs - The transaction outputs
 * @param heightlock - Block heightlock
 */
export const addUtxos = async (
  mysql: any,
  txId: string,
  outputs: TxOutputWithIndex[],
  heightlock: number | null = null,
): Promise<void> => {
  // outputs might be empty if we're destroying authorities
  if (outputs.length === 0) return;

  const entries = outputs.map(
    (output) => {
      let authorities = 0;
      let value = output.value;

      if (isAuthority(output.token_data)) {
        authorities = value;
        value = 0;
      }

      return [
        txId,
        output.index,
        output.token,
        value,
        authorities,
        output.decoded?.address,
        output.decoded?.timelock,
        heightlock,
        output.locked,
      ];
    },
  );

  // we are safe to ignore duplicates because our transaction might have already been in the mempool
  await mysql.query(
    `INSERT INTO \`tx_output\` (\`tx_id\`, \`index\`, \`token_id\`,
                           \`value\`, \`authorities\`, \`address\`,
                           \`timelock\`, \`heightlock\`, \`locked\`)
     VALUES ?
     ON DUPLICATE KEY UPDATE tx_id=tx_id`,
    [entries],
  );
};

/**
 * Remove a tx inputs from the utxo table.
 *
 * @param mysql - Database connection
 * @param inputs - The transaction inputs
 * @param txId - The transaction that spent these utxos
 */
export const updateTxOutputSpentBy = async (mysql: any, inputs: DbTxOutput[], txId: string): Promise<void> => {
  const entries = inputs.map((input) => [input.txId, input.index]);
  // entries might be empty if there are no inputs
  if (entries.length) {
    // get the rows before deleting

    /* We are forcing this query to use the PRIMARY index because MySQL is not using the index when there is
     * more than 185 elements in the IN query. I couldn't find a reason for that. Here is the EXPLAIN with exactly 185
     * elements:
     * +----+-------------+-----------+------------+-------+---------------+---------+---------+-------------+------+
     * | id | select_type | table     | partitions | type  | possible_keys | key     | key_len | ref         | rows |
     * +----+-------------+-----------+------------+-------+---------------+---------+---------+-------------+------+
     * |  1 | UPDATE      | tx_output | NULL       | range | PRIMARY       | PRIMARY | 259     | const,const |  250 |
     * +----+-------------+-----------+------------+-------+---------------+---------+---------+-------------+------+
     *
     * And here is the EXPLAIN query with exactly 186 elements:
     * +----+-------------+-----------+------------+-------+---------------+---------+---------+------+---------+
     * | id | select_type | table     | partitions | type  | possible_keys | key     | key_len | ref  | rows    |
     * +----+-------------+-----------+------------+-------+---------------+---------+---------+------+---------+
     * |  1 | UPDATE      | tx_output | NULL       | index | NULL          | PRIMARY | 259     | NULL | 1933979 |
     * +----+-------------+-----------+------------+-------+---------------+---------+---------+------+---------+
     */
    await mysql.query(
      `UPDATE \`tx_output\` USE INDEX (PRIMARY)
          SET \`spent_by\` = ?
        WHERE (\`tx_id\` ,\`index\`)
           IN (?)`,
      [txId, entries],
    );
  }
};

/**
 * Get a list of tx outputs from a list of txId and indexes
 *
 * @param mysql - Database connection
 * @param transactions - The list of transactions

 * @returns A list of tx outputs
 */
export const getTxOutputs = async (
  mysql: any,
  inputs: {txId: string, index: number}[],
): Promise<DbTxOutput[]> => {
  if (inputs.length <= 0) return [];
  const txIdIndexPair = inputs.map((utxo) => [utxo.txId, utxo.index]);
  console.log('Searching for', txIdIndexPair);
  const [results] = await mysql.query(
    `SELECT *
       FROM \`tx_output\`
      WHERE (\`tx_id\`, \`index\`) IN (?)`,
    [txIdIndexPair],
  );

  const utxos = [];
  for (const result of results) {
    console.log('Rsult: ', result);
    const utxo: DbTxOutput = {
      txId: result.tx_id as string,
      index: result.index as number,
      tokenId: result.token_id as string,
      address: result.address as string,
      value: result.value as number,
      authorities: result.authorities as number,
      timelock: result.timelock as number,
      heightlock: result.heightlock as number,
      locked: result.locked > 0,
      txProposalId: result.tx_proposal as string,
      txProposalIndex: result.tx_proposal_index as number,
      spentBy: result.spent_by ? result.spent_by as string : null,
    };
    utxos.push(utxo);
  }

  return utxos;
};

