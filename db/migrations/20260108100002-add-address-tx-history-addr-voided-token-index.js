'use strict';

module.exports = {
  up: async (queryInterface) => {
    // Check if index exists
    const [indexes] = await queryInterface.sequelize.query(`
      SELECT COUNT(DISTINCT index_name) as count
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'address_tx_history'
        AND index_name = 'idx_address_tx_history_addr_voided_token';
    `);

    // Only create if it doesn't exist
    if (indexes[0].count === 0) {
      await queryInterface.sequelize.query(`
        CREATE INDEX idx_address_tx_history_addr_voided_token
        ON address_tx_history (address, voided, token_id);
      `);
    }
  },

  down: async (queryInterface) => {
    // Check if index exists before dropping
    const [indexes] = await queryInterface.sequelize.query(`
      SELECT COUNT(DISTINCT index_name) as count
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'address_tx_history'
        AND index_name = 'idx_address_tx_history_addr_voided_token';
    `);

    if (indexes[0].count > 0) {
      await queryInterface.sequelize.query(`
        DROP INDEX idx_address_tx_history_addr_voided_token ON address_tx_history;
      `);
    }
  },
};
