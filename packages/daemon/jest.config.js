module.exports = {
  setupFiles: ["<rootDir>/setupTests.js"],
  roots: ["<rootDir>/__tests__"],
  testRegex: ".*\\.test\\.ts$",
  transform: {
    "^.+\\.ts$": ["ts-jest", {
      tsconfig: "./tsconfig.json",
      babelConfig: {
        sourceMaps: true,
      }
    }]
  },
  testPathIgnorePatterns: ['<rootDir>/__tests__/integration/'],
  moduleFileExtensions: ["ts", "js", "json", "node"],
  forceExit: true
};
