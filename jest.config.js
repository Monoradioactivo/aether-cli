/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/bin/", "/__tests__/fixtures/"],
  collectCoverage: true,
  collectCoverageFrom: ["script/**/*.ts", "!script/**/*.d.ts"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "html", "lcov"],
  coverageThreshold: {
    global: {
      statements: 75,
      branches: 55,
      functions: 80,
      lines: 75,
    },
  },
};
