import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory=dirname(fileURLToPath(import.meta.url));
const root=resolve(directory,'../android');
const gradle=resolve(root,'app/build.gradle');
let text=readFileSync(gradle,'utf8');
if(text.includes('journalverification'))throw new Error('Prebuild a fresh Android project first.');
text=text.replace("applicationId 'com.galinum.nativefoundation'", "applicationId 'com.galinum.journalverification'");
text=text.replace('react {',"react {\n    debuggableVariants = []");
text=text.replace(/entryFile = .*\n/,"entryFile = file('../../verification/index.ts')\n");
text += `
android.buildTypes.create('journalVerification') {
    initWith android.buildTypes.release
    debuggable true
    matchingFallbacks = ['release']
    signingConfig android.signingConfigs.debug
}
dependencies {
    journalVerificationImplementation 'net.zetetic:sqlcipher-android:4.17.0'
    journalVerificationImplementation 'androidx.sqlite:sqlite:2.6.2'
}
`;
writeFileSync(gradle,text);
const main=resolve(root,'app/src/main/java/com/galinum/nativefoundation/MainApplication.kt');
text=readFileSync(main,'utf8').replace('context = applicationContext,','context = applicationContext,\n      useDevSupport = false,').replace('PackageList(this).packages.apply {','PackageList(this).packages.apply {\n          add(com.galinum.journal.JournalHarness.Package())');
writeFileSync(main,text);
const destination=resolve(root,'app/src/journalVerification/java/com/galinum/journal/JournalHarness.java');
mkdirSync(dirname(destination),{recursive:true});copyFileSync(resolve(directory,'android/JournalHarness.java'),destination);
copyFileSync(resolve(root,'app/src/debug/AndroidManifest.xml'),resolve(root,'app/src/journalVerification/AndroidManifest.xml'));
console.log('Prepared disposable debug-only journal fixture.');
