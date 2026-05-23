'use strict';

/**
 * Creates `shielded_tx_output_data`, the 1:1 satellite table holding the
 * heavy on-chain cryptographic bytes for every shielded `tx_output` row.
 * Keyed by the same composite PK `(tx_id, index)` as `tx_output`, with a
 * FK ON DELETE CASCADE so vertex removal automatically cleans up the
 * satellite — no application-layer second delete.
 *
 * Column specifics (per design):
 *   - `index` matches `tx_output.index` in name and type, removing the
 *     `output_index` ↔ `index` naming asymmetry an earlier revision had.
 *   - Most byte columns are VARBINARY-capped to their on-chain size caps.
 *     `range_proof` and `surjection_proof` stay as BLOB for now (their
 *     final caps are still being measured against real on-chain samples).
 *   - `token_data` is `TINYINT UNSIGNED` to cover the full 0–255 wire
 *     byte range — signed TINYINT would not fit values >= 128.
 *
 * Uses raw SQL throughout because Sequelize's BLOB family doesn't map to
 * fixed-cap VARBINARY, and `index` is a SQL-reserved keyword requiring
 * backtick quoting.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE TABLE shielded_tx_output_data (
        tx_id VARCHAR(64) NOT NULL,
        \`index\` SMALLINT UNSIGNED NOT NULL,
        commitment VARBINARY(33) NOT NULL,
        range_proof BLOB NOT NULL,
        script VARBINARY(1024) NOT NULL,
        ephemeral_pubkey VARBINARY(33) NOT NULL,
        token_data TINYINT UNSIGNED NULL,
        asset_commitment VARBINARY(33) NULL,
        surjection_proof BLOB NULL,
        CONSTRAINT pk_shielded_tx_output_data PRIMARY KEY (tx_id, \`index\`),
        CONSTRAINT fk_shielded_tx_output_data_tx_output
          FOREIGN KEY (tx_id, \`index\`)
          REFERENCES tx_output(tx_id, \`index\`)
          ON DELETE CASCADE
      )
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('shielded_tx_output_data');
  },
};
