'use strict';

module.exports = {
  up: async (queryInterface) => {
    // Check if index exists
    const [indexes] = await queryInterface.sequelize.query(`
      SELECT COUNT(DISTINCT index_name) as count
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'tx_output'
        AND index_name = 'idx_tx_output_utxo_lookup';
    `);

    // Only create if it doesn't exist
    if (indexes[0].count === 0) {
      await queryInterface.sequelize.query(`
        CREATE INDEX idx_tx_output_utxo_lookup
        ON tx_output (address, token_id, spent_by, voided, locked, authorities);
      `);
    }
  },

  down: async (queryInterface) => {
    // Check if index exists before dropping
    const [indexes] = await queryInterface.sequelize.query(`
      SELECT COUNT(DISTINCT index_name) as count
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'tx_output'
        AND index_name = 'idx_tx_output_utxo_lookup';
    `);

    if (indexes[0].count > 0) {
      await queryInterface.sequelize.query(`
        DROP INDEX idx_tx_output_utxo_lookup ON tx_output;
      `);
    }
  },
};
