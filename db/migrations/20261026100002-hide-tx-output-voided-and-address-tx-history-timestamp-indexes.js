'use strict';

/**
 * Makes two indexes invisible to the optimizer, as the first step of dropping
 * them. Both lead the optimizer into worse plans than it finds without them:
 *
 * - `tx_output_voided_idx (voided)`: with two values, MySQL estimates
 *   `voided = FALSE` as half the table and picks this index over an address
 *   range, then walks every row. On test data with one heavy address, the
 *   `address IN (...) AND voided = FALSE` lookups took 230 ms with it and
 *   35 ms without it. No query needs it.
 * - `address_tx_history_timestamp_idx (timestamp)`: no query filters on
 *   `timestamp` alone, and it makes the explorer's
 *   `address = ? AND token_id = ? ORDER BY timestamp DESC LIMIT n` history
 *   query scan the whole index backwards.
 *
 * An invisible index is still maintained, so this is instant to apply and to
 * revert. A follow-up migration drops both once a release has run with them
 * invisible and no slow query has appeared.
 */
const INDEXES = [
  { table: 'tx_output', name: 'tx_output_voided_idx' },
  { table: 'address_tx_history', name: 'address_tx_history_timestamp_idx' },
];

module.exports = {
  up: async (queryInterface) => {
    for (const { table, name } of INDEXES) {
      await queryInterface.sequelize.query(`ALTER TABLE ${table} ALTER INDEX ${name} INVISIBLE`);
    }
  },

  down: async (queryInterface) => {
    for (const { table, name } of INDEXES) {
      await queryInterface.sequelize.query(`ALTER TABLE ${table} ALTER INDEX ${name} VISIBLE`);
    }
  },
};
