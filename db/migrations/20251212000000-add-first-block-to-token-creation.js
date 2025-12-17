'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('token_creation', 'first_block', {
      type: Sequelize.STRING(64),
      allowNull: true,
      comment: 'First block hash that confirmed the nano contract execution that created this token',
    });

    await queryInterface.addIndex('token_creation', ['first_block'], {
      name: 'token_creation_first_block_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('token_creation', 'token_creation_first_block_idx');
    await queryInterface.removeColumn('token_creation', 'first_block');
  },
};
