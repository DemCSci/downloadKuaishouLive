#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_PRIMARY_RELEASE = 'b6.1.1';
const OVERRIDE_RELEASE = process.env.FFMPEG_CUSTOM_RELEASE || '';
const DEFAULT_BASE_URL =
  process.env.FFMPEG_CUSTOM_BASE_URL || 'https://cdn.npmmirror.com/binaries/ffmpeg-static';
const RELEASE_FALLBACK_BY_TARGET = {
  'win32-ia32': 'b6.0',
};

const TARGETS = {
  'win32-x64': {
    assetName: 'ffmpeg-win32-x64.gz',
    outputRelativePath: path.join('win32-x64', 'ffmpeg.exe'),
  },
  'win32-ia32': {
    assetName: 'ffmpeg-win32-ia32.gz',
    outputRelativePath: path.join('win32-ia32', 'ffmpeg.exe'),
  },
  'darwin-x64': {
    assetName: 'ffmpeg-darwin-x64.gz',
    outputRelativePath: path.join('darwin-x64', 'ffmpeg'),
  },
  'darwin-arm64': {
    assetName: 'ffmpeg-darwin-arm64.gz',
    outputRelativePath: path.join('darwin-arm64', 'ffmpeg'),
  },
  'linux-x64': {
    assetName: 'ffmpeg-linux-x64.gz',
    outputRelativePath: path.join('linux-x64', 'ffmpeg'),
  },
};

function resolveKeys(inputArg) {
  if (!inputArg || inputArg === 'default') {
    return ['win32-x64'];
  }

  if (inputArg === 'win:all') {
    return ['win32-x64', 'win32-ia32'];
  }

  if (inputArg === 'desktop:all') {
    return ['win32-x64', 'win32-ia32', 'darwin-x64', 'darwin-arm64'];
  }

  if (inputArg === 'all') {
    return Object.keys(TARGETS);
  }

  return inputArg
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveReleaseByTarget(targetKey) {
  if (OVERRIDE_RELEASE) {
    return OVERRIDE_RELEASE;
  }

  return RELEASE_FALLBACK_BY_TARGET[targetKey] || DEFAULT_PRIMARY_RELEASE;
}

function makeRequestUrl(release, assetName) {
  return `${DEFAULT_BASE_URL}/${release}/${assetName}`;
}

async function downloadBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败: ${url}，HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function downloadAndExtractTarget(rootDir, key) {
  const target = TARGETS[key];
  if (!target) {
    throw new Error(`不支持的目标架构: ${key}`);
  }

  const release = resolveReleaseByTarget(key);
  const url = makeRequestUrl(release, target.assetName);
  const outputPath = path.join(rootDir, target.outputRelativePath);
  const outputDir = path.dirname(outputPath);
  ensureDir(outputDir);

  process.stdout.write(`[prepare-ffmpeg] downloading ${key} (${release}) from ${url}\n`);
  const gzBuffer = await downloadBuffer(url);
  const binaryBuffer = zlib.gunzipSync(gzBuffer);
  fs.writeFileSync(outputPath, binaryBuffer, { mode: 0o755 });
  process.stdout.write(`[prepare-ffmpeg] ready ${key}: ${outputPath}\n`);

  return {
    key,
    release,
    outputPath,
  };
}

async function main() {
  const inputArg = process.argv[2];
  const keys = resolveKeys(inputArg);

  if (keys.length === 0) {
    throw new Error('请提供至少一个目标架构');
  }

  const projectRoot = path.resolve(__dirname, '..');
  const outputRoot = path.join(projectRoot, 'ffmpeg-custom');
  ensureDir(outputRoot);

  const results = [];
  for (const key of keys) {
    // eslint-disable-next-line no-await-in-loop
    const result = await downloadAndExtractTarget(outputRoot, key);
    results.push(result);
  }

  const metadata = {
    generatedAt: new Date().toISOString(),
    defaultRelease: DEFAULT_PRIMARY_RELEASE,
    releaseOverride: OVERRIDE_RELEASE || null,
    baseUrl: DEFAULT_BASE_URL,
    targets: results.map((item) => ({
      key: item.key,
      release: item.release,
      outputPath: path.relative(outputRoot, item.outputPath),
    })),
  };
  fs.writeFileSync(
    path.join(outputRoot, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf8'
  );

  process.stdout.write('[prepare-ffmpeg] done\n');
}

main().catch((error) => {
  process.stderr.write(`[prepare-ffmpeg] failed: ${error.message}\n`);
  process.exit(1);
});
