'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('wallet_balance', 'unlocked_shielded_balance', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('wallet_balance', 'locked_shielded_balance', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('wallet_balance', 'shielded_timelock_expires', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
    await queryInterface.addColumn('wallet_balance', 'total_shielded_received', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('wallet_balance', 'total_shielded_received');
    await queryInterface.removeColumn('wallet_balance', 'shielded_timelock_expires');
    await queryInterface.removeColumn('wallet_balance', 'locked_shielded_balance');
    await queryInterface.removeColumn('wallet_balance', 'unlocked_shielded_balance');
  },
};
