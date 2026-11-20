import fs from 'node:fs';
import path from 'node:path';

const versionCode = process.env.VERSION_CODE;
const versionName = process.env.VERSION_NAME;

if (!versionCode || !versionName) {
  throw new Error('Missing VERSION_CODE or VERSION_NAME environment variables.');
}

const gradlePath = path.resolve(process.env.GRADLE_FILE || 'android/app/build.gradle');
let content = fs.readFileSync(gradlePath, 'utf8');

if (!/versionCode\s+\d+/.test(content) || !/versionName\s+"[^"]*"/.test(content)) {
  throw new Error(`Could not find versionCode/versionName in ${gradlePath}`);
}

content = content.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
content = content.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`);

if (!content.includes('signingConfig signingConfigs.release')) {
  const buildTypesReleasePattern = /(buildTypes\s*\{[\s\S]*?\brelease\s*\{)/;
  if (!buildTypesReleasePattern.test(content)) {
    throw new Error(`Could not find buildTypes { release { ... } } in ${gradlePath}`);
  }
  content = content.replace(
    buildTypesReleasePattern,
    '$1\n            signingConfig signingConfigs.release'
  );
}

const signingBlock = [
  'signingConfigs {',
  '        release {',
  '            storeFile file(System.getenv("FEI_STORE_FILE") ?: project.findProperty("FEI_STORE_FILE"))',
  '            storePassword System.getenv("FEI_STORE_PASSWORD") ?: project.findProperty("FEI_STORE_PASSWORD")',
  '            keyAlias System.getenv("FEI_KEY_ALIAS") ?: project.findProperty("FEI_KEY_ALIAS")',
  '            keyPassword System.getenv("FEI_KEY_PASSWORD") ?: project.findProperty("FEI_KEY_PASSWORD")',
  '        }',
  '    }',
  '    buildTypes {',
].join('\n');

if (!/signingConfigs\s*\{/.test(content)) {
  if (!/buildTypes\s*\{/.test(content)) {
    throw new Error(`Could not find buildTypes block in ${gradlePath}`);
  }
  content = content.replace(/buildTypes\s*\{/, signingBlock);
}

fs.writeFileSync(gradlePath, content, 'utf8');
console.log(`Patched ${gradlePath}: versionName=${versionName}, versionCode=${versionCode}`);
