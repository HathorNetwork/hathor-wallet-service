'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('tx_output', 'mode', {
      type: Sequelize.TINYINT,
      allowNull: false,
      defaultValue: 0,
      comment: '0=transparent, 1=AMOUNT_SHIELDED, 2=FULLY_SHIELDED',
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE tx_output
        ADD COLUMN recovery_state ENUM('unowned','recovered','recovery_failed') NULL
        COMMENT 'NULL when mode=0; lifecycle for shielded rows'
    `);

    await queryInterface.changeColumn('tx_output', 'value', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: true,
    });

    await queryInterface.changeColumn('tx_output', 'token_id', {
      type: Sequelize.STRING(64),
      allowNull: true,
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

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`DROP INDEX idx_tx_output_voided_mode ON tx_output`);
    await queryInterface.sequelize.query(`DROP INDEX idx_tx_output_mode_recovery ON tx_output`);
    await queryInterface.changeColumn('tx_output', 'token_id', {
      type: Sequelize.STRING(64),
      allowNull: false,
    });
    await queryInterface.changeColumn('tx_output', 'value', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: false,
    });
    await queryInterface.removeColumn('tx_output', 'recovery_state');
    await queryInterface.removeColumn('tx_output', 'mode');
  },
};
