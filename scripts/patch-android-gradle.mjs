import fs from 'node:fs';
import path from 'node:path';

const versionCode = process.env.VERSION_CODE;
const versionName = process.env.VERSION_NAME;

if (!versionCode || !versionName) {
  throw new Error('Missing VERSION_CODE or VERSION_NAME environment variables.');
}

const gradlePath = path.resolve('android/app/build.gradle');
let content = fs.readFileSync(gradlePath, 'utf8');

content = content.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
content = content.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`);

const signingBlock = [
  '    signingConfigs {',
  '        release {',
  '            storeFile file(project.findProperty("FEI_STORE_FILE"))',
  '            storePassword project.findProperty("FEI_STORE_PASSWORD")',
  '            keyAlias project.findProperty("FEI_KEY_ALIAS")',
  '            keyPassword project.findProperty("FEI_KEY_PASSWORD")',
  '        }',
  '    }',
  '    buildTypes {',
].join('\n');

if (!content.includes('signingConfigs')) {
  content = content.replace(/buildTypes\s*\{/, signingBlock);
}

if (!content.includes('signingConfig signingConfigs.release')) {
  content = content.replace(
    /release\s*\{/,
    'release {\n            signingConfig signingConfigs.release'
  );
}

fs.writeFileSync(gradlePath, content, 'utf8');
console.log(`Patched ${gradlePath}: versionName=${versionName}, versionCode=${versionCode}`);
