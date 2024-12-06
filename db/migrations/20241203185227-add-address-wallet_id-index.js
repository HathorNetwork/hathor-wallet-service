'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex(
      'address',
      ['wallet_id', 'index'],
      {
        name: 'idx_wallet_address_index',
      }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('address', 'idx_wallet_address_index');
  }
};
