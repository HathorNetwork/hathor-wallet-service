'use strict';

/**
 * Extends `tx_output` for shielded-output support:
 *
 *   - Adds `mode` (0=transparent, 1=AMOUNT_SHIELDED, 2=FULLY_SHIELDED)
 *     and `recovery_state` (NULL for transparent rows).
 *   - Relaxes `value` and `token_id` to NULL — both are unknown for
 *     unrecovered shielded outputs at insert time.
 */
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
    // Preconditions FIRST — fail fast before any destructive DDL.
    // If a guard threw after a DROP INDEX or changeColumn ran, the schema
    // would be in a half-rolled-back state and retrying would fail at the
    // DROP (because the indexes are already gone) with no clean recovery.

    // Guard against NULL rows before restoring NOT NULL on value/token_id.
    // The up() relaxed both columns specifically to admit shielded rows where
    // these are unknown at insert time; if any such row exists, the rollback
    // can't faithfully reverse without losing data.
    const [nullRows] = await queryInterface.sequelize.query(
      'SELECT COUNT(*) AS c FROM tx_output WHERE value IS NULL OR token_id IS NULL'
    );
    const nullCount = Number(nullRows[0]?.c ?? 0);
    if (nullCount > 0) {
      throw new Error(
        `Rollback blocked: tx_output has ${nullCount} rows with NULL value or token_id `
        + '(introduced by shielded inserts). Restore those to non-null or void/remove the '
        + 'rows before re-running the down migration.'
      );
    }

    // Preconditions cleared — proceed with the destructive DDL.
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
