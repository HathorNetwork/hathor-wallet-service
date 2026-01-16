'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add column as NOT NULL with default 1 (TokenVersion.DEPOSIT)
    await queryInterface.addColumn('token', 'version', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 1,
      comment: 'Token version: 0 = NATIVE (HTR), 1 = DEPOSIT, 2 = FEE',
    });

    // Set HTR (id = '00') to version 0 (TokenVersion.NATIVE)
    await queryInterface.sequelize.query(
      "UPDATE `token` SET `version` = 0 WHERE `id` = '00'"
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('token', 'version');
  },
};
