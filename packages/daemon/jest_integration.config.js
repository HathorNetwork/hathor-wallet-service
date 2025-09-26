// Minor helper for test development. Allows for specific file testing.
// (Taken from the wallet-headless repository)
const mainTestMatch = process.env.SPECIFIC_INTEGRATION_TEST_FILE
  ? `<rootDir>/__tests__/integration/**/${process.env.SPECIFIC_INTEGRATION_TEST_FILE}.test.ts`
  : '<rootDir>/__tests__/integration/**/*.test.ts';

module.exports = {
  setupFiles: ["<rootDir>/setupTests.js"],
  roots: ["<rootDir>/__tests__"],
  transform: {
    "^.+\\.ts$": ["ts-jest", {
      tsconfig: "./tsconfig.json",
      babelConfig: {
        sourceMaps: true,
      }
    }]
  },
  testMatch: [mainTestMatch],
  moduleFileExtensions: ["ts", "js", "json", "node"]
};
