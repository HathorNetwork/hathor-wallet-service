'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('token_creation', {
      token_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        primaryKey: true,
        references: {
          model: 'token',
          key: 'id',
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      tx_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        comment: 'Transaction ID that created the token (regular or nano contract)',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    // Add index on tx_id for efficient lookups when voiding transactions
    await queryInterface.addIndex('token_creation', ['tx_id'], {
      name: 'token_creation_tx_id_idx',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('token_creation');
  },
};
