#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_LOW_DISK_GB = 10;

function printHelp() {
  console.log(`
jiuyi CLI - Linux server live recorder

Usage:
  node cli.js --url <stream_url> [options]

Options:
  --url, -u            Live stream URL (required)
  --out, -o            Output file path (default: <out-dir>/live-YYYYMMDD-HHMMSS.mkv)
  --out-dir, -d        Output directory (default: ./records)
  --ffmpeg             Custom ffmpeg binary path
  --interval           Progress log interval in seconds (default: 5)
  --threshold-gb       Auto-stop threshold in GB (default: 10)
  --no-low-disk-protect  Disable low disk auto-stop
  --help, -h           Show this help

Examples:
  node cli.js --url "https://example.com/live.flv?token=xxx"
  node cli.js --url "https://example.com/live.flv" --out-dir /data/records
  node cli.js --url "https://example.com/live.flv" --out /data/live.mkv --threshold-gb 5
`);
}

function parseArgs(argv) {
  const options = {
    url: '',
    out: '',
    outDir: path.resolve(process.cwd(), 'records'),
    ffmpeg: '',
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    thresholdGb: DEFAULT_LOW_DISK_GB,
    lowDiskProtect: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];

    if (current === '--help' || current === '-h') {
      options.help = true;
      continue;
    }

    if (current === '--url' || current === '-u') {
      options.url = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (current === '--out' || current === '-o') {
      options.out = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (current === '--out-dir' || current === '-d') {
      options.outDir = path.resolve(argv[i + 1] || '');
      i += 1;
      continue;
    }

    if (current === '--ffmpeg') {
      options.ffmpeg = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (current === '--interval') {
      options.intervalSeconds = Number(argv[i + 1] || DEFAULT_INTERVAL_SECONDS);
      i += 1;
      continue;
    }

    if (current === '--threshold-gb') {
      options.thresholdGb = Number(argv[i + 1] || DEFAULT_LOW_DISK_GB);
      i += 1;
      continue;
    }

    if (current === '--no-low-disk-protect') {
      options.lowDiskProtect = false;
      continue;
    }

    throw new Error(`未知参数: ${current}`);
  }

  return options;
}

function nowStamp() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ];
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ];
  return `${parts.join('-')} ${time.join(':')}`;
}

function log(message) {
  console.log(`[${nowStamp()}] ${message}`);
}

function formatBytes(bytes) {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = safeBytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const fractionDigits = unitIndex === 0 ? 0 : 2;
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

function ensureDirectoryWritable(directoryPath) {
  const normalizedPath = path.resolve(directoryPath);
  fs.mkdirSync(normalizedPath, { recursive: true });
  fs.accessSync(normalizedPath, fs.constants.W_OK);
  return normalizedPath;
}

function buildTimestampFileName() {
  const now = new Date();
  return `live-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate()
  ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(
    now.getMinutes()
  ).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.mkv`;
}

function isSnapshotPath(filePath) {
  if (!filePath) {
    return false;
  }
  return (
    filePath.includes(`${path.sep}snapshot${path.sep}`) ||
    filePath.includes('/snapshot/') ||
    filePath.includes('\\snapshot\\')
  );
}

function materializeBinaryIfNeeded(binaryPath) {
  if (!process.pkg || !isSnapshotPath(binaryPath)) {
    return binaryPath;
  }

  const extension = path.extname(binaryPath);
  const binaryName = extension ? `ffmpeg${extension}` : 'ffmpeg';
  const targetDir = path.join(os.tmpdir(), 'jiuyi-ffmpeg', `${process.platform}-${process.arch}`);
  const targetPath = path.join(targetDir, binaryName);

  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(binaryPath, targetPath);
    if (process.platform !== 'win32') {
      fs.chmodSync(targetPath, 0o755);
    }
  }

  return targetPath;
}

function getExternalBundledFfmpeg() {
  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const platformTag = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(path.dirname(process.execPath), 'ffmpeg-bundled', platformTag, binaryName),
    path.join(process.cwd(), 'ffmpeg-bundled', platformTag, binaryName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return '';
}

function getInstallerFfmpegPath() {
  try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    if (installer && installer.path && fs.existsSync(installer.path)) {
      return installer.path;
    }
  } catch {
    // ignore
  }
  return '';
}

function resolveFfmpegBinary(explicitPath) {
  if (explicitPath) {
    const normalized = path.resolve(explicitPath);
    if (!fs.existsSync(normalized)) {
      throw new Error(`指定的 ffmpeg 不存在: ${normalized}`);
    }
    return normalized;
  }

  const bundled = getExternalBundledFfmpeg();
  if (bundled) {
    return bundled;
  }

  const installer = getInstallerFfmpegPath();
  if (installer) {
    return materializeBinaryIfNeeded(installer);
  }

  return 'ffmpeg';
}

async function checkFfmpegAvailable(ffmpegBinary) {
  return new Promise((resolve, reject) => {
    const probe = spawn(ffmpegBinary, ['-version']);

    probe.once('error', (error) => {
      reject(
        new Error(
          `找不到可用 FFmpeg: ${error.message}。可执行 apt install ffmpeg，或通过 --ffmpeg 指定路径。`
        )
      );
    });

    probe.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg 检查失败，退出码: ${code}`));
    });
  });
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

async function getDiskFreeBytes(targetPath) {
  try {
    if (process.platform === 'win32') {
      const root = path.parse(path.resolve(targetPath)).root;
      const deviceId = root.replace(/\\/g, '').toUpperCase();
      const { stdout } = await execFileAsync('wmic', [
        'logicaldisk',
        'where',
        `DeviceID='${deviceId}'`,
        'get',
        'FreeSpace',
        '/value',
      ]);
      const match = stdout.match(/FreeSpace=(\d+)/i);
      return match ? Number(match[1]) : 0;
    }

    const { stdout } = await execFileAsync('df', ['-k', targetPath]);
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length < 2) {
      return 0;
    }
    const parts = lines[lines.length - 1].trim().split(/\s+/);
    const availableKb = Number(parts[3]);
    return Number.isFinite(availableKb) ? availableKb * 1024 : 0;
  } catch {
    return 0;
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function run() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    console.error(`参数错误: ${error.message}`);
    printHelp();
    process.exit(1);
    return;
  }

  if (options.help) {
    printHelp();
    process.exit(0);
    return;
  }

  if (!options.url) {
    console.error('缺少必填参数: --url');
    printHelp();
    process.exit(1);
    return;
  }

  if (!Number.isFinite(options.intervalSeconds) || options.intervalSeconds <= 0) {
    throw new Error('--interval 必须大于 0');
  }

  if (!Number.isFinite(options.thresholdGb) || options.thresholdGb < 0) {
    throw new Error('--threshold-gb 不能小于 0');
  }

  const lowDiskThresholdBytes = options.lowDiskProtect
    ? options.thresholdGb * 1024 * 1024 * 1024
    : 0;

  const ffmpegBinary = resolveFfmpegBinary(options.ffmpeg);
  await checkFfmpegAvailable(ffmpegBinary);

  const outputPath = options.out
    ? path.resolve(options.out)
    : path.join(ensureDirectoryWritable(options.outDir), buildTimestampFileName());
  ensureDirectoryWritable(path.dirname(outputPath));

  log(`开始录制 URL: ${options.url}`);
  log(`输出文件: ${outputPath}`);
  log(`FFmpeg: ${ffmpegBinary}`);
  if (lowDiskThresholdBytes > 0) {
    log(`低磁盘保护: ${options.thresholdGb} GB`);
  } else {
    log('低磁盘保护: 已禁用');
  }

  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'info',
    '-i',
    options.url,
    '-c',
    'copy',
    '-f',
    'matroska',
    outputPath,
  ];

  const ffmpegProcess = spawn(ffmpegBinary, ffmpegArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stopRequested = false;
  let stopReason = '';
  let hasWrittenFrames = false;
  let stderrRemainder = '';
  let stopping = false;
  let lowDiskTriggered = false;
  let progressPolling = false;

  function handleStderrLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed.includes('frame=')) {
      hasWrittenFrames = true;
      return;
    }
    log(trimmed);
  }

  function processStderrChunk(chunk) {
    const normalizedChunk = chunk.toString('utf8').replace(/\r/g, '\n');
    const text = `${stderrRemainder}${normalizedChunk}`;
    const lines = text.split('\n');
    stderrRemainder = lines.pop() || '';
    lines.forEach(handleStderrLine);

    if (stderrRemainder.length > 4096) {
      handleStderrLine(stderrRemainder);
      stderrRemainder = '';
    }
  }

  const closePromise = new Promise((resolve) => {
    ffmpegProcess.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });

  async function stopRecording(reason) {
    if (stopping) {
      return;
    }
    stopping = true;
    stopRequested = true;
    stopReason = reason;

    try {
      ffmpegProcess.stdin.write('q\n');
    } catch {
      // ignore
    }

    let exited = await Promise.race([closePromise.then(() => true), wait(6000).then(() => false)]);
    if (!exited) {
      ffmpegProcess.kill('SIGINT');
      exited = await Promise.race([closePromise.then(() => true), wait(3000).then(() => false)]);
    }
    if (!exited && !ffmpegProcess.killed) {
      ffmpegProcess.kill('SIGKILL');
    }
  }

  const intervalMs = Math.max(1, Math.floor(options.intervalSeconds * 1000));
  const progressTimer = setInterval(async () => {
    if (progressPolling) {
      return;
    }
    progressPolling = true;

    try {
      const fileSize = getFileSize(outputPath);
      const diskFree = await getDiskFreeBytes(path.dirname(outputPath));
      log(`录制中: 文件 ${formatBytes(fileSize)}，磁盘剩余 ${formatBytes(diskFree)}`);

      if (
        !lowDiskTriggered &&
        lowDiskThresholdBytes > 0 &&
        Number.isFinite(diskFree) &&
        diskFree > 0 &&
        diskFree < lowDiskThresholdBytes
      ) {
        lowDiskTriggered = true;
        log(`磁盘剩余低于 ${options.thresholdGb} GB，自动停止录制...`);
        await stopRecording('low_disk');
      }
    } catch (error) {
      log(`进度检查失败: ${error.message}`);
    } finally {
      progressPolling = false;
    }
  }, intervalMs);

  function onSignal(signal) {
    log(`收到信号 ${signal}，正在停止录制...`);
    stopRecording('manual').catch((error) => {
      log(`停止失败: ${error.message}`);
    });
  }

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  ffmpegProcess.stderr.on('data', processStderrChunk);
  ffmpegProcess.stdout.on('data', (chunk) => {
    const output = chunk.toString('utf8').trim();
    if (output) {
      log(output);
    }
  });
  ffmpegProcess.once('error', (error) => {
    log(`ffmpeg 进程错误: ${error.message}`);
  });

  const { code, signal } = await closePromise;
  clearInterval(progressTimer);
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  if (stderrRemainder.trim()) {
    handleStderrLine(stderrRemainder);
  }

  const fileSize = getFileSize(outputPath);
  const hasFile = fileSize > 0;

  if (stopRequested) {
    if (stopReason === 'low_disk') {
      log(
        hasFile
          ? `已因磁盘不足自动停止，文件保存成功 (${formatBytes(fileSize)})`
          : '已因磁盘不足自动停止，但未检测到有效输出文件'
      );
      process.exit(hasFile ? 0 : 1);
      return;
    }

    log(hasFile ? `已手动停止，文件保存成功 (${formatBytes(fileSize)})` : '已手动停止，但无有效输出文件');
    process.exit(hasFile ? 0 : 1);
    return;
  }

  if (code === 0 || hasWrittenFrames || hasFile) {
    log(
      hasFile
        ? `直播已结束或中断，文件保存成功 (${formatBytes(fileSize)})`
        : '直播已结束，但无有效输出文件'
    );
    process.exit(hasFile ? 0 : 1);
    return;
  }

  log(`录制失败 (code=${code}, signal=${signal || 'none'})`);
  process.exit(1);
}

run().catch((error) => {
  console.error(`[${nowStamp()}] 运行失败: ${error.message}`);
  process.exit(1);
});
