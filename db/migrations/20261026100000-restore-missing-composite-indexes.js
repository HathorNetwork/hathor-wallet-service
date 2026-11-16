'use strict';

/**
 * Creates the composite indexes of four earlier migrations on databases where
 * those migrations ran without creating them.
 *
 * Before #415, each of those migrations compared the COUNT of its existing
 * index, which `bigNumberStrings` returns as a string, against the number 0.
 * The comparison was always false, so CREATE INDEX was silently skipped, and
 * the migration was still recorded as run. This migration creates each index
 * that is missing, with the same definition as its original migration, and
 * leaves the existing ones alone.
 *
 * down() drops nothing: the indexes belong to their original migrations,
 * which drop them on their own down().
 */

const INDEXES = [
  {
    table: 'tx_output',
    name: 'idx_tx_output_utxo_lookup',
    columns: '(address, token_id, spent_by, voided, locked, authorities)',
  },
  {
    table: 'tx_output',
    name: 'idx_tx_output_locked_heightlock',
    columns: '(locked, heightlock)',
  },
  {
    table: 'tx_output',
    name: 'idx_tx_output_locked_timelock',
    columns: '(locked, timelock)',
  },
  {
    table: 'address_tx_history',
    name: 'idx_address_tx_history_addr_voided_token',
    columns: '(address, voided, token_id)',
  },
];

const indexExists = async (queryInterface, table, name) => {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT COUNT(DISTINCT index_name) AS count
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND index_name = ?`,
    { replacements: [table, name] },
  );
  return Number(rows[0].count) > 0;
};

module.exports = {
  up: async (queryInterface) => {
    for (const { table, name, columns } of INDEXES) {
      if (!(await indexExists(queryInterface, table, name))) {
        await queryInterface.sequelize.query(
          `CREATE INDEX ${name} ON ${table} ${columns} ALGORITHM=INPLACE LOCK=NONE`,
        );
      }
    }
  },

  down: async () => {},
};
