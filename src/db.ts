/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
 import mysql from 'mysql2/promise';
 import {
   TxOutputWithIndex,
   TokenBalanceMap,
   DbTxOutput,
   StringMap,
  Transaction,
 } from './types';
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

export const voidTransaction = async (
  mysql: any,
  txId: string,
  addressBalanceMap: StringMap<TokenBalanceMap>,
): Promise<void> => {
  const addressEntries = Object.keys(addressBalanceMap).map((address) => [address, 0]);
  console.log('Handling voided tx: ', addressEntries);
  await mysql.query(
    `INSERT INTO \`address\`(\`address\`, \`transactions\`)
          VALUES ?
              ON DUPLICATE KEY UPDATE transactions = transactions - 1`,
    [addressEntries],
  );

  const entries = [];
  for (const [address, tokenMap] of Object.entries(addressBalanceMap)) {
    for (const [token, tokenBalance] of tokenMap.iterator()) {
      // update address_balance table or update balance and transactions if there's an entry already
      const entry = {
        address,
        token_id: token,
        // totalAmountSent is the sum of the value of all outputs of this token on the tx being sent to this address
        // which means it is the "total_received" for this address
        total_received: tokenBalance.totalAmountSent,
        // if it's < 0, there must be an entry already, so it will execute "ON DUPLICATE KEY UPDATE" instead of setting it to 0
        unlocked_balance: (tokenBalance.unlockedAmount < 0 ? 0 : tokenBalance.unlockedAmount),
        // this is never less than 0, as locked balance only changes when a tx is unlocked
        locked_balance: tokenBalance.lockedAmount,
        unlocked_authorities: tokenBalance.unlockedAuthorities.toUnsignedInteger(),
        locked_authorities: tokenBalance.lockedAuthorities.toUnsignedInteger(),
        timelock_expires: tokenBalance.lockExpires,
        transactions: 1,
      };
      // save the smaller value of timelock_expires, when not null
      await mysql.query(
        `INSERT INTO address_balance
                 SET ?
                  ON DUPLICATE KEY
                            UPDATE total_received = total_received - ?,
                                   unlocked_balance = unlocked_balance - ?,
                                   locked_balance = locked_balance - ?,
                                   transactions = transactions - 1,
                                   timelock_expires = CASE
                                                        WHEN timelock_expires IS NULL THEN VALUES(timelock_expires)
                                                        WHEN VALUES(timelock_expires) IS NULL THEN timelock_expires
                                                        ELSE LEAST(timelock_expires, VALUES(timelock_expires))
                                                      END,
                                   unlocked_authorities = (unlocked_authorities | VALUES(unlocked_authorities)),
                                   locked_authorities = locked_authorities | VALUES(locked_authorities)`,
        [entry, tokenBalance.totalAmountSent, tokenBalance.unlockedAmount, tokenBalance.lockedAmount, address, token],
      );

      // if we're removing any of the authorities, we need to refresh the authority columns. Unlike the values,
      // we cannot only sum/subtract, as authorities are binary: you have it or you don't. We might be spending
      // an authority output in this tx without creating a new one, but it doesn't mean this address does not
      // have this authority anymore, as it might have other authority outputs
      if (tokenBalance.unlockedAuthorities.hasNegativeValue()) {
        await mysql.query(
          `UPDATE \`address_balance\`
              SET \`unlocked_authorities\` = (
                SELECT BIT_OR(\`authorities\`)
                  FROM \`tx_output\`
                 WHERE \`address\` = ?
                   AND \`token_id\` = ?
                   AND \`locked\` = FALSE
                   AND \`spent_by\` IS NULL
                   AND \`voided\` = FALSE
              )
            WHERE \`address\` = ?
              AND \`token_id\` = ?`,
          [address, token, address, token],
        );
      }
      // for locked authorities, it doesn't make sense to perform the same operation. The authority needs to be
      // unlocked before it can be spent. In case we're just adding new locked authorities, this will be taken
      // care by the first sql query.

      // update address_tx_history with one entry for each pair (address, token)
      entries.push(txId);
    }
  }

  await mysql.query(
    `DELETE FROM \`address_tx_history\`
      WHERE \`tx_id\`
      IN (?)`,
    [entries],
  );
};

/**
 * Update addresses tables with a new transaction.
 *
 * @remarks
 * When a new transaction arrives, it will change the balance and tx history for addresses. This function
 * updates the address, address_balance and address_tx_history tables with information from this transaction.
 *
 * @param mysql - Database connection
 * @param txId - Transaction id
 * @param timestamp - Transaction timestamp
 * @param addressBalanceMap - Map with the transaction's balance for each address
 */
export const updateAddressTablesWithTx = async (
  mysql: any,
  txId: string,
  timestamp: number,
  addressBalanceMap: StringMap<TokenBalanceMap>,
): Promise<void> => {
  /*
   * update address table
   *
   * If an address is not yet present, add entry with index = null, walletId = null and transactions = 1.
   * Later, when the corresponding wallet is started, index and walletId will be updated.
   *
   * If address is already present, just increment the transactions counter.
   */
  const addressEntries = Object.keys(addressBalanceMap).map((address) => [address, 1]);
  await mysql.query(
    `INSERT INTO \`address\`(\`address\`, \`transactions\`)
          VALUES ?
              ON DUPLICATE KEY UPDATE transactions = transactions + 1`,
    [addressEntries],
  );

  const entries = [];
  for (const [address, tokenMap] of Object.entries(addressBalanceMap)) {
    for (const [token, tokenBalance] of tokenMap.iterator()) {
      // update address_balance table or update balance and transactions if there's an entry already
      const entry = {
        address,
        token_id: token,
        // totalAmountSent is the sum of the value of all outputs of this token on the tx being sent to this address
        // which means it is the "total_received" for this address
        total_received: tokenBalance.totalAmountSent,
        // if it's < 0, there must be an entry already, so it will execute "ON DUPLICATE KEY UPDATE" instead of setting it to 0
        unlocked_balance: (tokenBalance.unlockedAmount < 0 ? 0 : tokenBalance.unlockedAmount),
        // this is never less than 0, as locked balance only changes when a tx is unlocked
        locked_balance: tokenBalance.lockedAmount,
        unlocked_authorities: tokenBalance.unlockedAuthorities.toUnsignedInteger(),
        locked_authorities: tokenBalance.lockedAuthorities.toUnsignedInteger(),
        timelock_expires: tokenBalance.lockExpires,
        transactions: 1,
      };
      // save the smaller value of timelock_expires, when not null
      await mysql.query(
        `INSERT INTO address_balance
                 SET ?
                  ON DUPLICATE KEY
                            UPDATE total_received = total_received + ?,
                                   unlocked_balance = unlocked_balance + ?,
                                   locked_balance = locked_balance + ?,
                                   transactions = transactions + 1,
                                   timelock_expires = CASE
                                                        WHEN timelock_expires IS NULL THEN VALUES(timelock_expires)
                                                        WHEN VALUES(timelock_expires) IS NULL THEN timelock_expires
                                                        ELSE LEAST(timelock_expires, VALUES(timelock_expires))
                                                      END,
                                   unlocked_authorities = (unlocked_authorities | VALUES(unlocked_authorities)),
                                   locked_authorities = locked_authorities | VALUES(locked_authorities)`,
        [entry, tokenBalance.totalAmountSent, tokenBalance.unlockedAmount, tokenBalance.lockedAmount, address, token],
      );

      // if we're removing any of the authorities, we need to refresh the authority columns. Unlike the values,
      // we cannot only sum/subtract, as authorities are binary: you have it or you don't. We might be spending
      // an authority output in this tx without creating a new one, but it doesn't mean this address does not
      // have this authority anymore, as it might have other authority outputs
      if (tokenBalance.unlockedAuthorities.hasNegativeValue()) {
        await mysql.query(
          `UPDATE \`address_balance\`
              SET \`unlocked_authorities\` = (
                SELECT BIT_OR(\`authorities\`)
                  FROM \`tx_output\`
                 WHERE \`address\` = ?
                   AND \`token_id\` = ?
                   AND \`locked\` = FALSE
                   AND \`spent_by\` IS NULL
                   AND \`voided\` = FALSE
              )
            WHERE \`address\` = ?
              AND \`token_id\` = ?`,
          [address, token, address, token],
        );
      }
      // for locked authorities, it doesn't make sense to perform the same operation. The authority needs to be
      // unlocked before it can be spent. In case we're just adding new locked authorities, this will be taken
      // care by the first sql query.

      // update address_tx_history with one entry for each pair (address, token)
      entries.push([address, txId, token, tokenBalance.total(), timestamp]);
    }
  }

  await mysql.query(
    `INSERT INTO \`address_tx_history\`(\`address\`, \`tx_id\`,
                                        \`token_id\`, \`balance\`,
                                        \`timestamp\`)
     VALUES ?`,
    [entries],
  );
};

/**
 * Get a transaction by its ID.
 *
 * @param mysql - Database connection
 * @param txId - A transaction ID
 * @returns The requested transaction
 */
export const getTransactionById = async (
  mysql: any,
  txId: string,
): Promise<Transaction | null> => {
  const result = await mysql.query(`
   SELECT *
     FROM transaction
    WHERE tx_id = ?
  `, [txId]);

  if (result.length <= 0) {
    return null;
  }

  return result[0][0] as Transaction;
};
