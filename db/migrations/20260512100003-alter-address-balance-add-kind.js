'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('address_balance', 'kind', {
      type: Sequelize.ENUM('transparent', 'shielded'),
      allowNull: false,
      defaultValue: 'transparent',
    });

    await queryInterface.sequelize.query(`
      CREATE INDEX idx_address_balance_kind_token
        ON address_balance (kind, token_id)
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP INDEX idx_address_balance_kind_token ON address_balance`);
    await queryInterface.removeColumn('address_balance', 'kind');
  },
};
