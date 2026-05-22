'use strict';

/**
 * Adds shielded scan-path columns to the existing `address` table.
 *
 *   - `bip32_account` (NOT NULL DEFAULT 0): discriminates the BIP32 account
 *     path. 0 = transparent (m/44'/280'/0'), 1 = shielded scan path
 *     (m/44'/280'/1'). The ADD COLUMN backfills existing rows to 0 so the
 *     unique constraint `(wallet_id, bip32_account, index)` enforces strictly
 *     from this migration onward.
 *   - `scan_privkey` (VARBINARY(32) NULL): the Ristretto255 scalar used to
 *     rewind shielded commitments. Always exactly 32 bytes; VARBINARY is
 *     preferred over BLOB for inline storage. Populated only on shielded rows.
 *   - `catchup_state` (ENUM, NULL): tracks pending/running/done for the
 *     scan-catchup background process. NULL for transparent rows.
 *   - `shielded_address` (VARCHAR(100) NULL): user-facing long-form shielded
 *     address (71-byte payload, base58). NULL for transparent rows.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('address', 'bip32_account', {
      type: Sequelize.TINYINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
      comment: 'Hathor BIP32 account: 0 = transparent, 1 = shielded scan path. Existing rows backfilled to 0 by this ALTER TABLE.',
    });

    // Raw ALTER TABLE for VARBINARY(32) — Sequelize's BLOB family maps to
    // (TINY|MEDIUM|LONG)BLOB and doesn't expose a fixed-cap VARBINARY variant.
    await queryInterface.sequelize.query(`
      ALTER TABLE address
        ADD COLUMN scan_privkey VARBINARY(32) NULL
    `);

    await queryInterface.addColumn('address', 'catchup_state', {
      type: Sequelize.ENUM('pending', 'running', 'done'),
      allowNull: true,
    });

    await queryInterface.addColumn('address', 'shielded_address', {
      type: Sequelize.STRING(100),
      allowNull: true,
      comment: 'User-facing long-form shielded address (71-byte payload, base58, <=100 chars). NULL for transparent rows.',
    });

    await queryInterface.addIndex('address', ['wallet_id', 'bip32_account', 'index'], {
      unique: true,
      name: 'uk_address_wallet_account_index',
    });
    await queryInterface.addIndex('address', ['shielded_address'], {
      name: 'idx_address_shielded_long',
    });
    await queryInterface.addIndex('address', ['wallet_id', 'catchup_state'], {
      name: 'idx_address_wallet_catchup',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('address', 'idx_address_wallet_catchup');
    await queryInterface.removeIndex('address', 'idx_address_shielded_long');
    await queryInterface.removeIndex('address', 'uk_address_wallet_account_index');
    await queryInterface.removeColumn('address', 'shielded_address');
    await queryInterface.removeColumn('address', 'catchup_state');
    await queryInterface.removeColumn('address', 'scan_privkey');
    await queryInterface.removeColumn('address', 'bip32_account');
  },
};
