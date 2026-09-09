const path = require('node:path');
module.exports = {
  rootDir: path.resolve(__dirname, '..'),
  preset: '@react-native/jest-preset',
  testMatch: ['<rootDir>/test/inapp.render.jest.cjs'],
  transform: { '^.+\\.(js|ts|tsx)$': [require.resolve('babel-jest'), { presets: [require.resolve('@react-native/babel-preset')] }] },
  moduleNameMapper: { '^react$': '<rootDir>/node_modules/react', '^react-native$': '<rootDir>/node_modules/react-native', '^(\\.{1,2}/.*)\\.js$': '$1', '^@galinum/contracts/entry$': '<rootDir>/../contracts/src/entry.ts' },
  transformIgnorePatterns: ['/node_modules/(?!.*(?:react-native|@react-native)/)'],
};
