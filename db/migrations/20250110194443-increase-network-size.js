'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.changeColumn('version_data', 'network', {
      type: Sequelize.STRING(32),
      allowNull: false,
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.changeColumn('version_data', 'network', {
      type: Sequelize.STRING(8),
      allowNull: false,
    });
  }
};
