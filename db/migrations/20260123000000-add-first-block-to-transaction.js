'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transaction', 'first_block', {
      type: Sequelize.STRING(64),
      allowNull: true,
      comment: 'Hash of the first block that confirmed this transaction',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('transaction', 'first_block');
  },
};
