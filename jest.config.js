module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.tsx?$': ['@swc/jest'] },
  // Removes the temp cloud-assembly dirs CDK creates per App in tests.
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
  // Synthesizing a full app (incl. esbuild bundling) is slower than a typical unit test.
  testTimeout: 120_000,
};
