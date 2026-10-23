import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLatestManifest, writeSha256Sums } from '../scripts/ci/generate-latest-json.mjs';
import { inspectUpdaterArtifact } from '../scripts/ci/stage-updater-artifacts.mjs';
import { updaterErrorMessage } from '../src/features/updater/updaterErrors.ts';

const version = '0.0.4';
const targets = [
  ['aarch64-apple-darwin', '.app.tar.gz', 'darwin-aarch64'],
  ['x86_64-apple-darwin', '.app.tar.gz', 'darwin-x86_64'],
  ['x86_64-pc-windows-msvc', '.nsis.zip', 'windows-x86_64'],
];

function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'termvista-updater-test-'));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    const result = run(directory);
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function writeTestAssets(directory, omittedTarget = null, signatureVersion = version) {
  mkdirSync(directory, { recursive: true });
  const signature = Buffer.from(
    `untrusted comment: signature from minisign secret key\nfixture-signature\ntrusted comment: timestamp:0\tversion:${signatureVersion}\nfixture-global-signature`,
  ).toString('base64');
  for (const [target, extension] of targets) {
    if (target === omittedTarget) continue;
    const packagePath = join(directory, `TermVista_${version}_${target}${extension}`);
    writeFileSync(packagePath, `unit fixture for ${target}`);
    writeFileSync(packagePath + '.sig', signature);
  }
}

test('清单只列出三个精确平台键和同版本签名 URL', async () => {
  await withFixture((directory) => {
    writeTestAssets(directory);
    const manifest = generateLatestManifest({ tag: `v${version}`, assetDirectory: directory, notes: '测试更新说明' });
    assert.equal(manifest.version, version);
    assert.equal(manifest.notes, '测试更新说明');
    assert.deepEqual(Object.keys(manifest.platforms).sort(), targets.map(([, , key]) => key).sort());
    for (const [, , key] of targets) {
      assert.match(manifest.platforms[key].url, new RegExp(`/download/v${version}/TermVista_${version}_`));
      assert.ok(manifest.platforms[key].signature.length > 20);
    }
  });
});

test('缺少任一平台、版本签名不匹配或标签格式错误时拒绝生成清单', async () => {
  await withFixture((directory) => {
    writeTestAssets(directory, 'x86_64-apple-darwin');
    assert.throws(() => generateLatestManifest({ tag: `v${version}`, assetDirectory: directory, notes: '' }), /darwin-x86_64/);
    assert.throws(() => generateLatestManifest({ tag: 'v0.0.2', assetDirectory: directory, notes: '' }), /darwin-aarch64/);
    assert.throws(() => generateLatestManifest({ tag: 'latest', assetDirectory: directory, notes: '' }), /标签格式/);
  });

  await withFixture((directory) => {
    writeTestAssets(directory, null, '0.0.3');
    assert.throws(() => generateLatestManifest({ tag: `v${version}`, assetDirectory: directory, notes: '' }), /未绑定/);
  });
});

test('整理阶段要求提供签名密钥并要求 updater 包和签名同时存在', async () => {
  const signature = Buffer.from(
    'untrusted comment: signature from minisign secret key\nfixture\ntrusted comment: version:0.0.4',
  ).toString('base64');
  await withFixture((directory) => {
    const packagePath = join(directory, 'TermVista_0.0.4_aarch64-apple-darwin.app.tar.gz');
    const signaturePath = packagePath + '.sig';
    writeFileSync(packagePath, 'unit package fixture');
    writeFileSync(signaturePath, signature);
    assert.ok(inspectUpdaterArtifact({
      target: 'aarch64-apple-darwin', version, files: [packagePath, signaturePath], privateKeyPresent: false,
    }).issues.some((issue) => issue.includes('TAURI_SIGNING_PRIVATE_KEY')));
    assert.ok(inspectUpdaterArtifact({
      target: 'aarch64-apple-darwin', version, files: [packagePath], privateKeyPresent: true,
    }).issues.some((issue) => issue.includes('签名文件')));
    const checked = inspectUpdaterArtifact({
      target: 'aarch64-apple-darwin', version,
      files: [packagePath, signaturePath], privateKeyPresent: true,
    });
    assert.equal(checked.issues.length, 0);
    assert.equal(checked.packagePath, packagePath);
    assert.equal(checked.signaturePath, signaturePath);
  });
});

test('SHA256SUMS 包含全部发布文件且可重现地引用相对路径', async () => {
  await withFixture(async (directory) => {
    writeTestAssets(directory);
    const sumsPath = join(directory, 'SHA256SUMS.txt');
    await writeSha256Sums(directory, sumsPath);
    const lines = readFileSync(sumsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, targets.length * 2);
    assert.ok(lines.every((line) => /^[0-9a-f]{64}  TermVista_/.test(line)));
  });
});

test('更新错误将 404、网络超时和签名失败映射为可操作提示', () => {
  assert.match(updaterErrorMessage(new Error('HTTP 404')), /清单尚未发布/);
  assert.match(updaterErrorMessage(new Error('request timeout')), /检查网络后重试/);
  assert.match(updaterErrorMessage(new Error('signature verification failed')), /阻止安装/);
  assert.match(updaterErrorMessage(new Error('invalid latest manifest')), /更新操作失败/);
});
