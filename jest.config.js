/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  collectCoverageFrom: ["script/**/*.ts", "!script/**/*.d.ts"],
  coverageDirectory: "coverage",
  testPathIgnorePatterns: ["/node_modules/", "/bin/"],
};
