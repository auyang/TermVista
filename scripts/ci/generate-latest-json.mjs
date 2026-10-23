import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const platforms = [
  { target: 'aarch64-apple-darwin', key: 'darwin-aarch64', extension: '.app.tar.gz' },
  { target: 'x86_64-apple-darwin', key: 'darwin-x86_64', extension: '.app.tar.gz' },
  { target: 'x86_64-pc-windows-msvc', key: 'windows-x86_64', extension: '.nsis.zip' },
];
const repository = 'https://github.com/auyang/TermVista';

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function parseReleaseTag(tag) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  const match = /^v(.+)$/.exec(tag ?? '');
  if (!match || !semver.test(match[1])) throw new Error(`版本标签格式无效：${tag}`);
  return match[1];
}

export function generateLatestManifest({ tag, assetDirectory, notes, baseUrl = repository }) {
  const version = parseReleaseTag(tag);
  const assets = filesUnder(assetDirectory);
  const output = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {},
  };

  for (const platform of platforms) {
    const prefix = `TermVista_${version}_${platform.target}`;
    const packages = assets.filter((path) => basename(path).startsWith(prefix) && basename(path).endsWith(platform.extension));
    if (packages.length !== 1) {
      throw new Error(`${platform.key} 必须恰好有一个签名更新包，实际为 ${packages.length} 个。`);
    }
    const packagePath = packages[0];
    const signaturePath = packagePath + '.sig';
    if (!assets.includes(signaturePath)) throw new Error(`${platform.key} 缺少签名文件。`);
    const signature = readFileSync(signaturePath, 'utf8').trim();
    const decoded = Buffer.from(signature, 'base64');
    const signatureText = decoded.toString('utf8');
    if (!signature || decoded.toString('base64') !== signature
      || !signatureText.startsWith('untrusted comment: signature from minisign secret key\n')
      || !signatureText.includes(`version:${version}`)) {
      throw new Error(`${platform.key} 的签名格式无效或未绑定 ${version}。`);
    }
    const fileName = basename(packagePath);
    output.platforms[platform.key] = {
      url: `${baseUrl}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`,
      signature,
    };
  }

  return output;
}

export async function writeSha256Sums(assetDirectory, outputPath) {
  const files = filesUnder(assetDirectory)
    .filter((path) => path !== outputPath && !path.endsWith('SHA256SUMS.txt'))
    .sort();
  const lines = [];
  for (const path of files) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${basename(path)}`);
  }
  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const [tag, assetDirectory, notesPath, outputPath = join(assetDirectory ?? '.', 'latest.json')] = process.argv.slice(2);
  if (!tag || !assetDirectory || !notesPath) {
    throw new Error('用法：node scripts/ci/generate-latest-json.mjs <tag> <asset-dir> <notes-file> [output-file]');
  }
  const manifest = generateLatestManifest({ tag, assetDirectory, notes: readFileSync(notesPath, 'utf8').trim() });
  mkdirSync(assetDirectory, { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeSha256Sums(assetDirectory, join(assetDirectory, 'SHA256SUMS.txt'));
  console.log(`已生成 ${outputPath}，包含三个已签名平台的更新包。`);
}

if (basename(process.argv[1] ?? '') === 'generate-latest-json.mjs') main();
