'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('wallet', 'scan_xpriv', {
      type: Sequelize.BLOB,
      allowNull: true,
    });
    await queryInterface.addColumn('wallet', 'spend_xpub', {
      type: Sequelize.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('wallet', 'shielded_max_gap', {
      type: Sequelize.SMALLINT.UNSIGNED,
      allowNull: true,
      defaultValue: 20,
    });
    await queryInterface.addColumn('wallet', 'last_used_shielded_index', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
    await queryInterface.addColumn('wallet', 'shielded_status', {
      type: Sequelize.ENUM('none', 'catching-up', 'ready', 'error'),
      allowNull: false,
      defaultValue: 'none',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('wallet', 'shielded_status');
    await queryInterface.removeColumn('wallet', 'last_used_shielded_index');
    await queryInterface.removeColumn('wallet', 'shielded_max_gap');
    await queryInterface.removeColumn('wallet', 'spend_xpub');
    await queryInterface.removeColumn('wallet', 'scan_xpriv');
  },
};
