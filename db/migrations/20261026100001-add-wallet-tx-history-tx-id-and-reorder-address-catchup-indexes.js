'use strict';

/**
 * Adds `wallet_tx_history_tx_id_idx (tx_id)`. The daemon deletes a voided,
 * removed or un-voided transaction's rows with `WHERE tx_id = ?`. Without an
 * index that is a full scan which, under REPEATABLE READ, X-locks every row
 * of the table until the daemon commits, blocking wallet loads and the
 * shielded sweep. `address_tx_history` already has the equivalent index.
 *
 * The index is only created if missing, so a re-run after a failure later in
 * the deploy doesn't stop on a duplicate key name.
 *
 * The first version of this migration also replaced the address catchup
 * index; databases that ran it get the original index back from
 * 20261027100000-restore-address-wallet-catchup-index.
 */

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
    if (!(await indexExists(queryInterface, 'wallet_tx_history', 'wallet_tx_history_tx_id_idx'))) {
      await queryInterface.sequelize.query(
        'CREATE INDEX wallet_tx_history_tx_id_idx ON wallet_tx_history (tx_id) ALGORITHM=INPLACE LOCK=NONE',
      );
    }
  },

  down: async (queryInterface) => {
    if (await indexExists(queryInterface, 'wallet_tx_history', 'wallet_tx_history_tx_id_idx')) {
      await queryInterface.removeIndex('wallet_tx_history', 'wallet_tx_history_tx_id_idx');
    }
  },
};
