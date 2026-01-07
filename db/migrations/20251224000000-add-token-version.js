'use strict';
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('token', 'version', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 1, // Default to DEPOSIT (1) for existing tokens
    });

    // Set HTR token to NATIVE (version 0)
    await queryInterface.sequelize.query(
      "UPDATE token SET version = 0 WHERE id = '00'"
    );
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('token', 'version');
  },
};
