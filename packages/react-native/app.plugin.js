const { withAndroidManifest, withMainActivity, withPodfile, AndroidConfig } = require('expo/config-plugins');
const { relative } = require('node:path');

const SERVICE = 'com.galinum.journal.GalinumExpoMessagingService';
const EXPO_SERVICE = 'expo.modules.notifications.service.ExpoFirebaseMessagingService';
const CAPTURE = 'com.galinum.journal.GalinumNotificationActivity';
const RECEIPT_POD = 'GalinumReceiptStore';

function withGalinumManifest(config) {
  return withAndroidManifest(config, mod => {
    const manifest = mod.modResults.manifest;
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    application.service = (application.service ?? []).filter(service => ![SERVICE, EXPO_SERVICE].includes(service.$['android:name']));
    application.service.push({ $: { 'android:name': EXPO_SERVICE, 'tools:node': 'remove' } });
    application.service.push({
      $: { 'android:name': SERVICE, 'android:exported': 'false' },
      'intent-filter': [{ $: { 'android:priority': '1' }, action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }] }],
    });
    return mod;
  });
}

function withGalinumActivity(config) {
  return withMainActivity(config, mod => {
    const kotlin = mod.modResults.language === 'kt';
    let contents = mod.modResults.contents;
    if (contents.includes(CAPTURE)) return mod;
    if (kotlin) {
      if (!/^import android\.content\.Intent$/m.test(contents)) contents = contents.replace(/^import android\.os\.Bundle$/m, 'import android.content.Intent\nimport android.os.Bundle');
      contents = contents.replace(/(override fun onCreate\(savedInstanceState: Bundle\?\) \{\n)/, '$1    ' + CAPTURE + '.onCreate(this, savedInstanceState)\n');
      const method = '\n  override fun onNewIntent(intent: Intent) {\n    ' + CAPTURE + '.onNewIntent(this, intent)\n    super.onNewIntent(intent)\n  }\n';
      contents = contents.replace(/\n}\s*$/, method + '}\n');
    } else {
      if (!/^import android\.content\.Intent;$/m.test(contents)) contents = contents.replace(/^import android\.os\.Bundle;$/m, 'import android.content.Intent;\nimport android.os.Bundle;');
      contents = contents.replace(/(protected void onCreate\(Bundle savedInstanceState\) \{\n)/, '$1    ' + CAPTURE + '.onCreate(this, savedInstanceState);\n');
      const method = '\n  @Override\n  public void onNewIntent(Intent intent) {\n    ' + CAPTURE + '.onNewIntent(this, intent);\n    super.onNewIntent(intent);\n  }\n';
      contents = contents.replace(/\n}\s*$/, method + '}\n');
    }
    if (!contents.includes(CAPTURE + '.onCreate') || !contents.includes(CAPTURE + '.onNewIntent')) throw new Error('Galinum could not add notification capture to MainActivity');
    mod.modResults.contents = contents;
    return mod;
  });
}

function withGalinumPodfile(config) {
  return withPodfile(config, mod => {
    const contents = mod.modResults.contents;
    if (contents.includes("pod '" + RECEIPT_POD + "'")) return mod;
    const packagePath = relative(mod.modRequest.platformProjectRoot, __dirname).split('\\').join('/');
    const line = "  pod '" + RECEIPT_POD + "', :path => '" + packagePath + "'\n";
    const anchor = /^([ \t]*)use_expo_modules!\r?\n/m.exec(contents);
    if (!anchor) throw new Error('Galinum could not find use_expo_modules! in the application Podfile');
    const at = anchor.index + anchor[0].length;
    mod.modResults.contents = contents.slice(0, at) + line + contents.slice(at);
    return mod;
  });
}

module.exports = config => withGalinumPodfile(withGalinumActivity(withGalinumManifest(config)));
