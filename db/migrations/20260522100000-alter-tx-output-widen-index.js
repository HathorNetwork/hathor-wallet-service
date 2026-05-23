'use strict';

/**
 * Widen `tx_output.index` from TINYINT UNSIGNED (0-255) to SMALLINT UNSIGNED
 * (0-65535). Required because a vertex's concatenated transparent + shielded
 * output count can exceed 255 (255 transparent + up to 15 shielded).
 *
 * The satellite `shielded_tx_output_data.output_index` is widened in the same
 * migration so the foreign key reference stays type-aligned across the change.
 * The FK is dropped before the column-type changes and recreated afterwards.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE shielded_tx_output_data
        DROP FOREIGN KEY fk_shielded_tx_output_data_tx_output
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tx_output
        MODIFY COLUMN \`index\` SMALLINT UNSIGNED NOT NULL
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE shielded_tx_output_data
        MODIFY COLUMN \`output_index\` SMALLINT UNSIGNED NOT NULL
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE shielded_tx_output_data
        ADD CONSTRAINT fk_shielded_tx_output_data_tx_output
        FOREIGN KEY (tx_id, output_index)
        REFERENCES tx_output(tx_id, \`index\`)
        ON DELETE CASCADE
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE shielded_tx_output_data
        DROP FOREIGN KEY fk_shielded_tx_output_data_tx_output
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE shielded_tx_output_data
        MODIFY COLUMN \`output_index\` TINYINT UNSIGNED NOT NULL
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tx_output
        MODIFY COLUMN \`index\` TINYINT UNSIGNED NOT NULL
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE shielded_tx_output_data
        ADD CONSTRAINT fk_shielded_tx_output_data_tx_output
        FOREIGN KEY (tx_id, output_index)
        REFERENCES tx_output(tx_id, \`index\`)
        ON DELETE CASCADE
    `);
  },
};
