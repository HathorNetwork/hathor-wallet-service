'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('shielded_address', {
      address: {
        type: Sequelize.STRING(34),
        allowNull: false,
        primaryKey: true,
        comment: 'On-chain spend address (base58)',
      },
      wallet_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        comment: 'NULL until a wallet claims this address',
      },
      shielded_index: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
      },
      shielded_address: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: '71-byte payload, base58, <=100 chars; long user-facing form',
      },
      scan_privkey: {
        type: Sequelize.BLOB,
        allowNull: true,
      },
      catchup_state: {
        type: Sequelize.ENUM('pending', 'running', 'done'),
        allowNull: true,
      },
      transactions: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('shielded_address', ['wallet_id', 'shielded_index'], {
      unique: true,
      name: 'uk_shielded_address_wallet_idx',
    });

    await queryInterface.addIndex('shielded_address', ['shielded_address'], {
      name: 'idx_shielded_address_long',
    });

    await queryInterface.addIndex('shielded_address', ['wallet_id', 'catchup_state'], {
      name: 'idx_shielded_address_wallet_catchup',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('shielded_address');
  },
};
