'use strict';

/**
 * Adds a signed `shielded_balance_delta` column to `address_tx_history`,
 * mirroring `wallet_tx_history.shielded_balance_delta`. One row per
 * (address, tx_id, token_id) now carries both the transparent `balance`
 * and the shielded delta for vertices that touch both kinds.
 *
 * Signed BIGINT so spend reversals can write negative values directly.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('address_tx_history', 'shielded_balance_delta', {
      type: Sequelize.BIGINT,
      allowNull: false,
      defaultValue: 0,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('address_tx_history', 'shielded_balance_delta');
  },
};
