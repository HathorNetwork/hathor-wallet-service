'use strict';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.removeColumn('wallet_balance', 'shielded_timelock_expires');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('wallet_balance', 'shielded_timelock_expires', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
  },
};
