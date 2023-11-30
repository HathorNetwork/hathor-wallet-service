'use strict';
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('sync_metadata', {
      id: {
        type: Sequelize.INTEGER(),
        primaryKey: true,
        allowNull: false,
      },
      last_event_id: {
        type: Sequelize.INTEGER(),
        allowNull: false,
      },
      updated_at: {
        type: Sequelize.STRING(64),
        defaultValue: 0,
      },
    });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('wallet_tx_history');
  }
};
