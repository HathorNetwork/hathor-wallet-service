'use strict';

/**
 * Creates the public per-address tables the explorer reads.
 *
 * Both are written by the daemon at ingest from on-chain data only, and
 * reversed when a transaction is voided. Shielded-output recovery never writes
 * them, so every row and value is the same whether or not a shielded output
 * was recovered.
 *
 * - `public_address_tx_history`: one row per (address, token, tx) the address
 *   is publicly involved in. `balance` is the transparent delta only;
 *   `has_shielded` marks rows with a shielded output or input. FullyShielded
 *   involvement is recorded under the `fully_shielded` token_id sentinel.
 *   The primary key matches the explorer's history order, so a page is a
 *   reverse range scan.
 * - `public_address_tokens`: per-(address, token) counters derived from the
 *   history rows, ordered by `last_activity` for the token list.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('public_address_tx_history', {
      address: {
        type: Sequelize.STRING(34),
        allowNull: false,
        primaryKey: true,
      },
      token_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        primaryKey: true,
      },
      timestamp: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        primaryKey: true,
      },
      tx_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        primaryKey: true,
      },
      balance: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      has_shielded: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },
    });
    await queryInterface.addIndex('public_address_tx_history', ['tx_id'], {
      name: 'public_address_tx_history_tx_id_idx',
    });

    await queryInterface.createTable('public_address_tokens', {
      address: {
        type: Sequelize.STRING(34),
        allowNull: false,
        primaryKey: true,
      },
      token_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        primaryKey: true,
      },
      transactions: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
      },
      shielded_transactions: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
      },
      last_activity: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
      },
    });
    await queryInterface.addIndex('public_address_tokens', ['address', 'last_activity', 'token_id'], {
      name: 'public_address_tokens_activity_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('public_address_tokens');
    await queryInterface.dropTable('public_address_tx_history');
  },
};
