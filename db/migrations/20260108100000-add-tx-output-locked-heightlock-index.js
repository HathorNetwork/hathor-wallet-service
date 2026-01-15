'use strict';

module.exports = {
  up: async (queryInterface) => {
    // Check if index exists
    const [indexes] = await queryInterface.sequelize.query(`
      SELECT COUNT(DISTINCT index_name) as count
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'tx_output'
        AND index_name = 'idx_tx_output_locked_heightlock';
    `);

    // Only create if it doesn't exist
    if (indexes[0].count === 0) {
      await queryInterface.sequelize.query(`
        CREATE INDEX idx_tx_output_locked_heightlock
        ON tx_output (locked, heightlock);
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
        AND index_name = 'idx_tx_output_locked_heightlock';
    `);

    if (indexes[0].count > 0) {
      await queryInterface.sequelize.query(`
        DROP INDEX idx_tx_output_locked_heightlock ON tx_output;
      `);
    }
  },
};
