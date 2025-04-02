'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    // Dropping the table and recreating it is easier than deleting the fields then adding the new
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
    const { up } = require('./20210706175820-create-version-data');
    await up(queryInterface, Sequelize);
  }
};
