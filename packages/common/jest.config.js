module.exports = {
  roots: ["<rootDir>/__tests__"],
  testRegex: ".*\\.test\\.ts$",
  moduleNameMapper: {
    '^@src/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/__tests__/$1',
    '^@events/(.*)$': '<rootDir>/__tests__/events/$1',
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", {
      tsconfig: "./tsconfig.json",
      babelConfig: {
        sourceMaps: true,
      }
    }]
  },
  moduleFileExtensions: ["ts", "js", "json", "node"]
};
