import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const targetSuffix = new Map([
  ['aarch64-apple-darwin', '.app.tar.gz'],
  ['x86_64-apple-darwin', '.app.tar.gz'],
  ['x86_64-pc-windows-msvc', '.nsis.zip'],
]);

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

export function inspectUpdaterArtifact({ target, version, files, privateKeyPresent }) {
  const issues = [];
  if (!privateKeyPresent) issues.push('未提供 TAURI_SIGNING_PRIVATE_KEY，拒绝生成未签名更新包。');
  const suffix = targetSuffix.get(target);
  if (!suffix) issues.push(`不支持的更新目标：${target}`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    issues.push(`版本号无效：${version}`);
  }
  const packages = suffix ? files.filter((path) => path.endsWith(suffix)) : [];
  if (packages.length !== 1) issues.push(`目标 ${target} 必须恰好生成一个 ${suffix ?? '更新包'}，实际为 ${packages.length} 个。`);
  const packagePath = packages[0];
  const signaturePath = packagePath ? packagePath + '.sig' : null;
  if (signaturePath && !files.includes(signaturePath)) issues.push('更新包缺少 Tauri 签名文件。');
  if (signaturePath && files.includes(signaturePath)) {
    const signatureText = readFileSync(signaturePath, 'utf8').trim();
    let decoded = '';
    try {
      const bytes = Buffer.from(signatureText, 'base64');
      if (bytes.toString('base64') === signatureText) decoded = bytes.toString('utf8');
    } catch {
      decoded = '';
    }
    if (!decoded.startsWith('untrusted comment: signature from minisign secret key\n')
      || !decoded.includes(`version:${version}`)) {
      issues.push('签名格式无效，或签名未绑定当前版本。');
    }
  }
  return { issues, packagePath, signaturePath };
}

function main() {
  const [target, version, outputDirectory] = process.argv.slice(2);
  if (!target || !version || !outputDirectory) {
    throw new Error('用法：node scripts/ci/stage-updater-artifacts.mjs <target> <version> <output-dir>');
  }
  const bundleDirectory = join('src-tauri', 'target', target, 'release', 'bundle');
  const files = filesUnder(bundleDirectory);
  const result = inspectUpdaterArtifact({
    target,
    version,
    files,
    privateKeyPresent: Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY),
  });
  if (result.issues.length > 0) throw new Error(result.issues.join('\n'));

  mkdirSync(outputDirectory, { recursive: true });
  const extension = targetSuffix.get(target);
  const packageName = `TermVista_${version}_${target}${extension}`;
  const packageDestination = join(outputDirectory, packageName);
  const signatureDestination = packageDestination + '.sig';
  copyFileSync(result.packagePath, packageDestination);
  copyFileSync(result.signaturePath, signatureDestination);
  console.log(`已整理签名更新包：${basename(packageDestination)}`);
}

if (basename(process.argv[1] ?? '') === 'stage-updater-artifacts.mjs') main();
