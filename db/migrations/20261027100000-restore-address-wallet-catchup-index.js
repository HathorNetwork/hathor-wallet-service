'use strict';

/**
 * Puts back `idx_address_wallet_catchup (wallet_id, catchup_state)` where the
 * first version of 20261026100001 replaced it with
 * `idx_address_catchup_wallet (catchup_state, wallet_id)`.
 *
 * The `catchup_state`-first order lets the shielded sweep's wallet lookup read
 * only the flagged rows instead of probing every ready wallet. But if MySQL
 * also picks it for the sweep state updates, the gap locks a sweep commit
 * takes on its `running` entries are shared with every other wallet: a wallet
 * load marking its own rows `running` then waits for that whole commit
 * (measured: 4.5 s behind a 6 s commit, against 0.1 s when the update uses
 * the unique key). A slower lock-free read in a background job is the better
 * trade than wallet loads waiting on another wallet's sweep.
 *
 * Both steps check the current state first, so this is a no-op on databases
 * that never had the reorder, and safe to re-run.
 *
 * down() drops nothing: `idx_address_wallet_catchup` belongs to
 * 20260512100002, which drops it on its own down().
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
    if (!(await indexExists(queryInterface, 'address', 'idx_address_wallet_catchup'))) {
      await queryInterface.sequelize.query(
        'CREATE INDEX idx_address_wallet_catchup ON address (wallet_id, catchup_state) ALGORITHM=INPLACE LOCK=NONE',
      );
    }
    if (await indexExists(queryInterface, 'address', 'idx_address_catchup_wallet')) {
      await queryInterface.removeIndex('address', 'idx_address_catchup_wallet');
    }
  },

  down: async () => {},
};
