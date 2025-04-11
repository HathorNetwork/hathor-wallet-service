module.exports = {
  test: {
    username: 'root',
    password: 'hathor',
    database: 'hathor',
    host: '127.0.0.1',
    port: 3380,
    dialect: 'mysql',
    dialectOptions: {
      supportBigNumbers: true,
      bigNumberStrings: true,
    },
  },
};
