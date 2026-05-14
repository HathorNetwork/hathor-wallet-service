'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('shielded_tx_output_data', {
      tx_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      output_index: {
        type: Sequelize.TINYINT.UNSIGNED,
        allowNull: false,
      },
      commitment: {
        type: Sequelize.BLOB,
        allowNull: false,
      },
      range_proof: {
        type: Sequelize.BLOB('medium'),
        allowNull: false,
      },
      script: {
        type: Sequelize.BLOB,
        allowNull: false,
      },
      ephemeral_pubkey: {
        type: Sequelize.BLOB,
        allowNull: false,
      },
      token_data: {
        type: Sequelize.TINYINT,
        allowNull: true,
      },
      asset_commitment: {
        type: Sequelize.BLOB,
        allowNull: true,
      },
      surjection_proof: {
        type: Sequelize.BLOB('medium'),
        allowNull: true,
      },
    });

    await queryInterface.addConstraint('shielded_tx_output_data', {
      fields: ['tx_id', 'output_index'],
      type: 'primary key',
      name: 'pk_shielded_tx_output_data',
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE shielded_tx_output_data
        ADD CONSTRAINT fk_shielded_tx_output_data_tx_output
        FOREIGN KEY (tx_id, output_index)
        REFERENCES tx_output(tx_id, \`index\`)
        ON DELETE CASCADE
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('shielded_tx_output_data');
  },
};
