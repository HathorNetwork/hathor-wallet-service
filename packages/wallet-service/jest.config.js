module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    // Must precede the generic @src mapping. Keeps the native shielded crypto
    // provider out of every test; see tests/utils/shieldedCrypto.stub.ts.
    '^@src/shieldedCrypto$': '<rootDir>/tests/utils/shieldedCrypto.stub.ts',
    '^@src/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1',
    '^@events/(.*)$': '<rootDir>/events/$1',
  },
  setupFiles: ['./tests/jestSetup.ts'],
  testPathIgnorePatterns: [
    '<rootDir>/tests/utils/pushnotification.utils.boundary.test.ts',
    '<rootDir>/dist/',
  ],
  coveragePathIgnorePatterns: ['/node_modules/', '/tests/utils.ts'],
  coverageThreshold: {
    global: {
      branches: 88,
      functions: 91,
      lines: 93,
      statements: 93,
    },
  },
};
