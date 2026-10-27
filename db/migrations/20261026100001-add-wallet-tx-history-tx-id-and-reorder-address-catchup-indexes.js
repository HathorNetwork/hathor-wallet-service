'use strict';

/**
 * - `wallet_tx_history_tx_id_idx (tx_id)`: the daemon deletes a voided,
 *   removed or un-voided transaction's rows with `WHERE tx_id = ?`. Without an
 *   index that is a full scan which, under REPEATABLE READ, X-locks every row
 *   of the table until the daemon commits, blocking wallet loads and the
 *   shielded sweep. `address_tx_history` already has the equivalent index.
 * - `idx_address_catchup_wallet (catchup_state, wallet_id)` replaces
 *   `idx_address_wallet_catchup (wallet_id, catchup_state)`. The shielded
 *   sweep looks for wallets with `catchup_state IN ('pending', 'running')`
 *   rows, which the old column order cannot serve. The new order serves the
 *   sweep from the flagged rows only, and still serves the per-wallet state
 *   updates as a lookup on both columns. Same columns, same size.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      'CREATE INDEX wallet_tx_history_tx_id_idx ON wallet_tx_history (tx_id) ALGORITHM=INPLACE LOCK=NONE',
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX idx_address_catchup_wallet ON address (catchup_state, wallet_id) ALGORITHM=INPLACE LOCK=NONE',
    );
    await queryInterface.removeIndex('address', 'idx_address_wallet_catchup');
  },

  down: async (queryInterface) => {
    await queryInterface.addIndex('address', ['wallet_id', 'catchup_state'], {
      name: 'idx_address_wallet_catchup',
    });
    await queryInterface.removeIndex('address', 'idx_address_catchup_wallet');
    await queryInterface.removeIndex('wallet_tx_history', 'wallet_tx_history_tx_id_idx');
  },
};
