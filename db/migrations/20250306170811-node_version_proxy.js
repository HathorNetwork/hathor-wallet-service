'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    // Dropping the table and recreating it is easier than deleting the fields then addind the new
    // one, there is also no danger of losing any data since this is fetched from the fullnode
    await queryInterface.dropTable('version_data');
    await queryInterface.createTable('version_data', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        primaryKey: true,
        defaultValue: 1,
      },
      timestamp: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
      },
      data: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.dropTable('version_data');
    // The "old" table structure was copied from ./20210706175820-create-version-data.js
    await queryInterface.createTable('version_data', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        primaryKey: true,
        defaultValue: 1,
      },
      timestamp: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
      },
      version: {
        type: Sequelize.STRING(11),
        allowNull: false,
      },
      network: {
        type: Sequelize.STRING(8),
        allowNull: false,
      },
      min_weight: {
        type: Sequelize.FLOAT.UNSIGNED,
        allowNull: false,
      },
      min_tx_weight: {
        type: Sequelize.FLOAT.UNSIGNED,
        allowNull: false,
      },
      min_tx_weight_coefficient: {
        type: Sequelize.FLOAT.UNSIGNED,
        allowNull: false,
      },
      min_tx_weight_k: {
        type: Sequelize.FLOAT.UNSIGNED,
        allowNull: false,
      },
      token_deposit_percentage: {
        type: Sequelize.FLOAT.UNSIGNED,
        allowNull: false,
      },
      reward_spend_min_blocks: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
      },
      max_number_inputs: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
      },
      max_number_outputs: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
      },
    });
  }
};
