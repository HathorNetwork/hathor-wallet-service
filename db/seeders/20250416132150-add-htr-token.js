'use strict';

module.exports = {
  up: async (queryInterface) => {
    // Count unique transactions for HTR
    const [results] = await queryInterface.sequelize.query(
      "SELECT COUNT(DISTINCT tx_id) AS count FROM tx_output WHERE token_id = '00'"
    );
    const htrTxCount = results[0]?.count || 0;

    // Insert HTR token with the correct transaction count
    await queryInterface.bulkInsert('token', [{
      id: '00',
      name: 'Hathor',
      symbol: 'HTR',
      transactions: htrTxCount,
    }]);
  },

  down: async (queryInterface) => {
    await queryInterface.bulkDelete('token', { id: '00' });
  }
};
