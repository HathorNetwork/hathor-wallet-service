module.exports = {
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
  moduleFileExtensions: ["ts", "js", "json", "node"]
};
