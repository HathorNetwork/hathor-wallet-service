'use strict';

/**
 * Adds shielded amount columns to `address_balance` so the same row can
 * carry both transparent and shielded balances for an address. Mirrors the
 * wallet_balance shape (unlocked / locked / total per kind).
 *
 * Shielded outputs cannot carry authority bits and do not contribute to the
 * existing authority columns, so this migration only adds value columns.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('address_balance', 'unlocked_shielded_balance', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('address_balance', 'locked_shielded_balance', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('address_balance', 'total_shielded_received', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('address_balance', 'total_shielded_received');
    await queryInterface.removeColumn('address_balance', 'locked_shielded_balance');
    await queryInterface.removeColumn('address_balance', 'unlocked_shielded_balance');
  },
};
