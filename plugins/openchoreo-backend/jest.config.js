module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  transform: {
    '\\.[jt]sx?$': [
      require.resolve(
        '@backstage/cli-module-test-jest/config/jestSwcTransform',
      ),
      {
        jsc: {
          parser: { syntax: 'typescript', tsx: true },
          transform: { react: { runtime: 'automatic' } },
        },
      },
    ],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@kubernetes|@swc|@backstage/backend-test-utils))',
  ],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  testMatch: ['**/*.test.ts'],
};
