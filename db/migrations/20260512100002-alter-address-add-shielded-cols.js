'use strict';

/**
 * Adds CT-derivation columns to the existing `address` table.
 *
 *   - `bip32_account` (NULL): discriminates the BIP32 account a CLAIMED row
 *     was derived from. NULL on observation-only rows (no wallet has claimed
 *     the address yet); set to 0 = Legacy or 2 = CTSpend when a wallet
 *     registration writes its derivation slot. Account 1 = CTScan derives
 *     a scan key attached to the matching CTSpend row via `scan_privkey`
 *     and is never stored as a row identifier. The unique constraint
 *     `(wallet_id, bip32_account, index)` enforces one row per claimed
 *     derivation slot; MySQL treats NULL as distinct in UNIQUE indexes, so
 *     multiple unclaimed observations coexist freely.
 *   - `scan_privkey` (VARBINARY(32) NULL): the Ristretto255 scalar used to
 *     rewind shielded commitments. Always exactly 32 bytes; VARBINARY is
 *     preferred over BLOB for inline storage. Populated only on CTSpend rows.
 *   - `catchup_state` (ENUM, NULL): tracks pending/running/done for the
 *     scan-catchup background process. Populated only on CTSpend rows.
 *   - `ct_address` (VARCHAR(100) NULL): user-facing long-form CT address
 *     (71-byte payload, base58). Populated only on CTSpend rows. The
 *     address can be the destination of either a transparent or a shielded
 *     output, so the column name reflects the derivation path rather than
 *     the output kind.
 *
 * Existing rows are backfilled `bip32_account = 0` only when they're
 * already claimed (`wallet_id IS NOT NULL`); pre-existing observation-only
 * rows stay NULL since their derivation account isn't known.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('address', 'bip32_account', {
      type: Sequelize.TINYINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
      comment: 'Hathor BIP32 account for a claimed row: 0 = Legacy, 2 = CTSpend. NULL on observation-only rows. Value 1 = CTScan is reserved for the scan-key derivation and never stored.',
    });

    // Backfill claimed Legacy rows. Observation-only rows (wallet_id NULL)
    // stay at NULL — their derivation account isn't known until a wallet
    // registration claims them.
    await queryInterface.sequelize.query(
      'UPDATE `address` SET `bip32_account` = 0 WHERE `wallet_id` IS NOT NULL'
    );

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

    await queryInterface.addColumn('address', 'ct_address', {
      type: Sequelize.STRING(100),
      allowNull: true,
      comment: 'User-facing long-form CT address (71-byte payload, base58, <=100 chars). Populated only on CTSpend rows.',
    });

    await queryInterface.addIndex('address', ['wallet_id', 'bip32_account', 'index'], {
      unique: true,
      name: 'uk_address_wallet_account_index',
    });
    await queryInterface.addIndex('address', ['ct_address'], {
      name: 'idx_address_ct_long',
    });
    await queryInterface.addIndex('address', ['wallet_id', 'catchup_state'], {
      name: 'idx_address_wallet_catchup',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('address', 'idx_address_wallet_catchup');
    await queryInterface.removeIndex('address', 'idx_address_ct_long');
    await queryInterface.removeIndex('address', 'uk_address_wallet_account_index');
    await queryInterface.removeColumn('address', 'ct_address');
    await queryInterface.removeColumn('address', 'catchup_state');
    await queryInterface.removeColumn('address', 'scan_privkey');
    await queryInterface.removeColumn('address', 'bip32_account');
  },
};
