'use strict';

/**
 * Drops unused shielded-outputs foundations artifacts:
 *   - `token.total_supply`: its only reader was the invoke-only
 *     onTotalSupplyRequest lambda (also removed); total supply is read from
 *     the fullnode everywhere it is actually consumed.
 *   - `idx_tx_output_mode_recovery (mode, recovery_state)` and
 *     `idx_tx_output_voided_mode (voided, mode)`: no query uses either as an
 *     access path, and both lead with low-cardinality columns, so they only
 *     added write amplification without any read benefit.
 *
 * down() restores the column and both indexes to their original definitions.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX idx_tx_output_voided_mode ON tx_output');
    await queryInterface.sequelize.query('DROP INDEX idx_tx_output_mode_recovery ON tx_output');
    await queryInterface.removeColumn('token', 'total_supply');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('token', 'total_supply', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.sequelize.query(`
      CREATE INDEX idx_tx_output_mode_recovery
        ON tx_output (mode, recovery_state)
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX idx_tx_output_voided_mode
        ON tx_output (voided, mode)
    `);
  },
};
