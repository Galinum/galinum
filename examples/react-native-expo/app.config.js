const { existsSync } = require('node:fs');
const { join } = require('node:path');
const base = require('./app.json');

module.exports = () => {
  const googleServices = join(__dirname, 'google-services.json');
  const expo = { ...base.expo, plugins: [...base.expo.plugins, '@galinum/react-native'] };
  if (existsSync(googleServices)) expo.android = { ...expo.android, googleServicesFile: './google-services.json' };
  return { expo };
};
