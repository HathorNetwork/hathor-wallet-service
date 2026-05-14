'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('address_tx_history', 'kind', {
      type: Sequelize.ENUM('transparent', 'shielded'),
      allowNull: false,
      defaultValue: 'transparent',
    });

    await queryInterface.sequelize.query(`
      CREATE INDEX idx_address_tx_history_kind_token_ts
        ON address_tx_history (kind, token_id, timestamp DESC)
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP INDEX idx_address_tx_history_kind_token_ts ON address_tx_history`);
    await queryInterface.removeColumn('address_tx_history', 'kind');
  },
};
