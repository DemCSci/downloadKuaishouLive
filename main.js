const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const LOW_DISK_THRESHOLD_BYTES = 10 * 1024 * 1024 * 1024;
const RECOMMENDED_FFMPEG_MAJOR_VERSION = 5;

app.setName('jiuyi');

let mainWindow = null;
let ffmpegProcess = null;
let currentOutputPath = '';
let stopRequested = false;
let stopReason = '';
let hasWrittenFrames = false;
let ffmpegLogs = [];
let stderrRemainder = '';
let outputDirectory = '';
let progressTimer = null;
let lowDiskProtectionTriggered = false;

function handleStderrLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  if (trimmed.includes('frame=')) {
    hasWrittenFrames = true;
    return;
  }

  rememberLog(trimmed);
  sendRecordingEvent('log', { message: trimmed });
}

function sendRecordingEvent(type, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('recording:event', {
    type,
    ...payload,
  });
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
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

function getOutputDirectory() {
  return outputDirectory || app.getPath('videos');
}

function saveSettings() {
  const settingsPath = getSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ outputDirectory: getOutputDirectory() }, null, 2),
    'utf8'
  );
}

function loadSettings() {
  outputDirectory = app.getPath('videos');
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return;
  }

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.outputDirectory === 'string' &&
      parsed.outputDirectory.trim()
    ) {
      outputDirectory = parsed.outputDirectory.trim();
    }
  } catch {
    outputDirectory = app.getPath('videos');
  }
}

function setOutputDirectory(directoryPath) {
  if (!directoryPath || typeof directoryPath !== 'string') {
    throw new Error('保存目录无效');
  }

  const normalizedPath = ensureDirectoryWritable(directoryPath.trim());
  outputDirectory = normalizedPath;
  saveSettings();
  return outputDirectory;
}

function createOutputPath() {
  const outputDir = ensureDirectoryWritable(getOutputDirectory());
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');

  return path.join(outputDir, `live-${timestamp}.mkv`);
}

function rememberLog(line) {
  if (!line) {
    return;
  }

  ffmpegLogs.push(line);
  if (ffmpegLogs.length > 30) {
    ffmpegLogs = ffmpegLogs.slice(-30);
  }
}

function normalizeStartPayload(startPayload) {
  if (typeof startPayload === 'string') {
    return {
      mode: 'generic',
      url: startPayload.trim(),
    };
  }

  if (!startPayload || typeof startPayload !== 'object') {
    return {
      mode: 'generic',
      url: '',
    };
  }

  const mode = startPayload.mode === 'douyin' ? 'douyin' : 'generic';
  const url = typeof startPayload.url === 'string' ? startPayload.url.trim() : '';

  return {
    mode,
    url,
  };
}

function isDouyinLiveUrl(inputUrl) {
  try {
    const parsed = new URL(inputUrl);
    return parsed.hostname === 'live.douyin.com' || parsed.hostname.endsWith('.douyin.com');
  } catch {
    return false;
  }
}

function extractPotentialStreamUrlFromRequest(requestUrl) {
  if (!requestUrl || typeof requestUrl !== 'string') {
    return '';
  }

  const lower = requestUrl.toLowerCase();
  if (!lower.includes('.flv') && !lower.includes('.m3u8')) {
    return '';
  }

  if (lower.includes('uuu_265.mp4')) {
    return '';
  }

  return requestUrl;
}

function scoreStreamUrl(streamUrl) {
  const lower = streamUrl.toLowerCase();
  let score = 0;

  if (lower.includes('.flv')) {
    score += 50;
  }

  if (lower.includes('.m3u8')) {
    score += 40;
  }

  if (lower.includes('pull-flv')) {
    score += 20;
  }

  if (lower.includes('pull-hls')) {
    score += 10;
  }

  if (lower.includes('douyincdn.com')) {
    score += 8;
  }

  if (lower.includes('302_dispatch=true')) {
    score += 5;
  }

  if (lower.includes('_or')) {
    score += 1;
  }

  return score;
}

function selectPreferredStreamUrl(streamUrls) {
  if (!Array.isArray(streamUrls) || streamUrls.length === 0) {
    return '';
  }

  return [...streamUrls].sort((a, b) => scoreStreamUrl(b) - scoreStreamUrl(a))[0];
}

function getBundledFfmpegPath() {
  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const byPlatform = process.platform === 'win32'
    ? process.arch === 'ia32'
      ? ['win32-ia32', 'win32-x64']
      : ['win32-x64', 'win32-ia32']
    : process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? ['darwin-arm64', 'darwin-x64']
        : ['darwin-x64', 'darwin-arm64']
      : [];

  if (!app.isPackaged) {
    return '';
  }

  for (const platformDir of byPlatform) {
    const candidatePath = path.join(
      process.resourcesPath,
      'ffmpeg-bundled',
      platformDir,
      binaryName
    );
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return '';
}

function getLocalOverrideFfmpegPaths() {
  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];
  const byPlatform = process.platform === 'win32'
    ? process.arch === 'ia32'
      ? ['win32-ia32', 'win32-x64']
      : ['win32-x64', 'win32-ia32']
    : process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? ['darwin-arm64', 'darwin-x64']
        : ['darwin-x64', 'darwin-arm64']
      : process.platform === 'linux'
        ? process.arch === 'arm64'
          ? ['linux-arm64', 'linux-x64']
          : process.arch === 'arm'
            ? ['linux-arm', 'linux-x64']
            : process.arch === 'ia32'
              ? ['linux-ia32', 'linux-x64']
              : ['linux-x64', 'linux-ia32']
        : [];

  if (app.isPackaged) {
    candidates.push(path.join(path.dirname(process.execPath), binaryName));
    candidates.push(path.join(process.resourcesPath, binaryName));
    candidates.push(path.join(process.resourcesPath, 'ffmpeg-custom', binaryName));
    byPlatform.forEach((platformDir) => {
      candidates.push(path.join(process.resourcesPath, 'ffmpeg-custom', platformDir, binaryName));
    });
  } else {
    candidates.push(path.join(process.cwd(), binaryName));
    byPlatform.forEach((platformDir) => {
      candidates.push(path.join(process.cwd(), 'ffmpeg-custom', platformDir, binaryName));
    });
  }

  return candidates.filter((candidatePath) => fs.existsSync(candidatePath));
}

function getDevelopmentFfmpegPath() {
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

function parseFfmpegVersion(rawVersion) {
  if (!rawVersion || typeof rawVersion !== 'string') {
    return {
      major: 0,
      minor: 0,
      patch: 0,
      score: 0,
      text: '',
    };
  }

  const versionText = rawVersion.trim();
  const match = versionText.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    return {
      major: 0,
      minor: 0,
      patch: 0,
      score: 0,
      text: versionText,
    };
  }

  const major = Number(match[1] || 0);
  const minor = Number(match[2] || 0);
  const patch = Number(match[3] || 0);
  const score = major * 1_000_000 + minor * 1_000 + patch;

  return {
    major,
    minor,
    patch,
    score,
    text: versionText,
  };
}

function probeFfmpegBinary(binaryPath) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const probe = spawn(binaryPath, ['-version']);

    probe.stdout.on('data', (chunk) => {
      if (stdout.length < 4096) {
        stdout += chunk.toString('utf8');
      }
    });

    probe.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });

    probe.once('error', (error) => {
      resolve({
        ok: false,
        error: error.message,
      });
    });

    probe.once('close', (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          error: `退出码: ${code}`,
        });
        return;
      }

      const mergedOutput = `${stdout}\n${stderr}`;
      const versionLine = mergedOutput
        .split(/\r?\n/)
        .find((line) => line.toLowerCase().includes('ffmpeg version')) || '';
      const versionMatch = versionLine.match(/ffmpeg version\s+([^\s]+)/i);
      const versionRaw = versionMatch ? versionMatch[1] : '';

      resolve({
        ok: true,
        versionRaw,
        version: parseFfmpegVersion(versionRaw),
      });
    });
  });
}

function pushUniqueCandidate(candidates, seen, binaryPath, source, priority, options = {}) {
  const { mustExist = false } = options;
  if (!binaryPath || typeof binaryPath !== 'string') {
    return;
  }

  const trimmedPath = binaryPath.trim();
  if (!trimmedPath) {
    return;
  }

  if (mustExist && !fs.existsSync(trimmedPath)) {
    return;
  }

  const key = process.platform === 'win32' ? trimmedPath.toLowerCase() : trimmedPath;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  candidates.push({
    binaryPath: trimmedPath,
    source,
    priority,
  });
}

function collectFfmpegCandidates() {
  const candidates = [];
  const seen = new Set();

  const envOverride = process.env.JIUYI_FFMPEG_PATH;
  pushUniqueCandidate(candidates, seen, envOverride, 'env', 0, { mustExist: true });

  getLocalOverrideFfmpegPaths().forEach((candidatePath) => {
    pushUniqueCandidate(candidates, seen, candidatePath, 'local', 1, { mustExist: true });
  });

  // 系统 PATH 中的 ffmpeg（命令名）
  pushUniqueCandidate(candidates, seen, 'ffmpeg', 'system', 2, { mustExist: false });

  pushUniqueCandidate(candidates, seen, getBundledFfmpegPath(), 'bundled', 3, { mustExist: true });
  pushUniqueCandidate(candidates, seen, getDevelopmentFfmpegPath(), 'development', 4, {
    mustExist: true,
  });

  return candidates;
}

function formatFfmpegSource(source) {
  if (source === 'env') {
    return '环境变量 JIUYI_FFMPEG_PATH';
  }
  if (source === 'local') {
    return '本地覆盖文件';
  }
  if (source === 'system') {
    return '系统 PATH';
  }
  if (source === 'bundled') {
    return '应用内置';
  }
  if (source === 'development') {
    return '开发依赖';
  }

  return source || 'unknown';
}

async function checkFfmpegAvailable() {
  const candidates = collectFfmpegCandidates();
  const success = [];
  const failed = [];

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await probeFfmpegBinary(candidate.binaryPath);
    if (probe.ok) {
      success.push({
        ...candidate,
        versionRaw: probe.versionRaw,
        version: probe.version,
      });
      continue;
    }

    failed.push(`${candidate.binaryPath}(${probe.error || 'unknown'})`);
  }

  if (success.length === 0) {
    throw new Error(
      `找不到可用 FFmpeg。请安装较新版本 FFmpeg，或设置环境变量 JIUYI_FFMPEG_PATH 指向 ffmpeg 可执行文件。尝试过: ${failed.join('; ')}`
    );
  }

  success.sort((a, b) => {
    if (b.version.score !== a.version.score) {
      return b.version.score - a.version.score;
    }
    return a.priority - b.priority;
  });

  const selected = success[0];
  if (selected.version.major > 0 && selected.version.major < RECOMMENDED_FFMPEG_MAJOR_VERSION) {
    sendRecordingEvent('log', {
      message: `当前 FFmpeg 版本较低（${selected.version.text || selected.versionRaw}），建议升级到 ${RECOMMENDED_FFMPEG_MAJOR_VERSION}.x 或更高版本，以避免部分直播流解析失败。`,
    });
  }

  return selected;
}

async function resolveDouyinStreamUrl(pageUrl, timeoutMs = 25000) {
  if (!isDouyinLiveUrl(pageUrl)) {
    throw new Error('请输入有效的抖音直播间页面链接（live.douyin.com）');
  }

  return new Promise((resolve, reject) => {
    let done = false;
    let timeoutId = null;
    const streamCandidates = new Set();
    const partition = `douyin-resolver-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let resolverWindow = null;
    let resolverSession = null;

    const finishResolve = (streamUrl) => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      resolve(streamUrl);
    };

    const finishReject = (message) => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      reject(new Error(message));
    };

    const onBeforeRequest = (details, callback) => {
      try {
        const streamUrl = extractPotentialStreamUrlFromRequest(details.url);
        if (streamUrl) {
          streamCandidates.add(streamUrl);
          const preferred = selectPreferredStreamUrl([...streamCandidates]);
          if (preferred) {
            finishResolve(preferred);
          }
        }
      } catch (error) {
        sendRecordingEvent('log', {
          message: `抖音流地址监听异常: ${error.message}`,
        });
      } finally {
        callback({ cancel: false });
      }
    };

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      if (resolverSession) {
        try {
          resolverSession.webRequest.onBeforeRequest(null);
        } catch {
          // ignore
        }
      }

      if (resolverWindow && !resolverWindow.isDestroyed()) {
        resolverWindow.destroy();
      }
    };

    try {
      resolverWindow = new BrowserWindow({
        show: false,
        width: 1200,
        height: 800,
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });

      resolverSession = resolverWindow.webContents.session;
      resolverSession.webRequest.onBeforeRequest(
        {
          urls: ['*://*/*'],
        },
        onBeforeRequest
      );

      resolverWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        if (errorCode === -3) {
          return;
        }
        finishReject(`抖音页面加载失败: ${errorDescription} (${errorCode})`);
      });

      resolverWindow.webContents.on('render-process-gone', () => {
        finishReject('抖音页面解析失败: 渲染进程异常退出');
      });

      resolverWindow.webContents.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );

      timeoutId = setTimeout(() => {
        const fallback = selectPreferredStreamUrl([...streamCandidates]);
        if (fallback) {
          finishResolve(fallback);
          return;
        }

        finishReject('未能解析到抖音直播流地址，请确认直播间正在开播后重试');
      }, timeoutMs);

      resolverWindow.loadURL(pageUrl).catch((error) => {
        finishReject(`抖音页面加载失败: ${error.message}`);
      });
    } catch (error) {
      finishReject(`抖音页面解析初始化失败: ${error.message}`);
    }
  });
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

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

async function getDiskFreeBytes(targetPath) {
  const safePath = targetPath || getOutputDirectory();

  try {
    if (process.platform === 'win32') {
      const root = path.parse(path.resolve(safePath)).root;
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

    const { stdout } = await execFileAsync('df', ['-k', safePath]);
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length < 2) {
      return 0;
    }

    const parts = lines[lines.length - 1].trim().split(/\s+/);
    const availableKb = Number(parts[3]);
    if (!Number.isFinite(availableKb)) {
      return 0;
    }

    return availableKb * 1024;
  } catch {
    return 0;
  }
}

function stopProgressTicker() {
  if (!progressTimer) {
    return;
  }

  clearInterval(progressTimer);
  progressTimer = null;
}

function showLowDiskWarning(diskFree) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['我知道了'],
    defaultId: 0,
    title: '磁盘空间不足',
    message: '磁盘剩余空间低于 10 GB，录制已自动停止。',
    detail: `当前剩余 ${formatBytes(diskFree)}，请清理磁盘空间后再继续录制。`,
  }).catch(() => {
    // ignore
  });
}

async function emitProgress() {
  if (!ffmpegProcess || !currentOutputPath) {
    return;
  }

  const fileSize = getFileSize(currentOutputPath);
  const diskFree = await getDiskFreeBytes(path.dirname(currentOutputPath));
  sendRecordingEvent('progress', {
    outputPath: currentOutputPath,
    fileSize,
    diskFree,
    message: `录制中：文件 ${formatBytes(fileSize)}，磁盘剩余 ${formatBytes(diskFree)}。`,
  });

  if (
    !lowDiskProtectionTriggered &&
    Number.isFinite(diskFree) &&
    diskFree > 0 &&
    diskFree < LOW_DISK_THRESHOLD_BYTES
  ) {
    lowDiskProtectionTriggered = true;
    sendRecordingEvent('warning', {
      outputPath: currentOutputPath,
      fileSize,
      diskFree,
      message: `磁盘剩余低于 10 GB（当前 ${formatBytes(diskFree)}），已自动停止录制。`,
    });
    showLowDiskWarning(diskFree);
    await stopRecording('low_disk');
  }
}

function startProgressTicker() {
  stopProgressTicker();
  progressTimer = setInterval(() => {
    emitProgress().catch(() => {
      // ignore
    });
  }, 5000);

  emitProgress().catch(() => {
    // ignore
  });
}

async function startRecording(startPayload) {
  const { mode, url } = normalizeStartPayload(startPayload);

  if (!url) {
    throw new Error(mode === 'douyin' ? '请输入抖音直播链接' : '请输入直播链接');
  }

  if (ffmpegProcess) {
    throw new Error('当前已有录制任务在运行');
  }

  const ffmpegInfo = await checkFfmpegAvailable();
  const ffmpegBinary = ffmpegInfo.binaryPath;
  sendRecordingEvent('log', {
    message: `已选择 FFmpeg: ${ffmpegBinary}（来源: ${formatFfmpegSource(ffmpegInfo.source)}，版本: ${ffmpegInfo.versionRaw || 'unknown'}）`,
  });
  let inputUrl = url;

  if (mode === 'douyin') {
    sendRecordingEvent('log', {
      message: '正在解析抖音直播页，获取真实流地址...',
    });
    inputUrl = await resolveDouyinStreamUrl(url);
    sendRecordingEvent('log', {
      message: '抖音流地址解析成功，开始启动录制...',
    });
  }

  currentOutputPath = createOutputPath();
  stopRequested = false;
  stopReason = '';
  hasWrittenFrames = false;
  ffmpegLogs = [];
  stderrRemainder = '';
  lowDiskProtectionTriggered = false;

  const args = [
    '-hide_banner',
    '-loglevel',
    'info',
    '-i',
    inputUrl,
    '-c',
    'copy',
    '-f',
    'matroska',
    currentOutputPath,
  ];

  ffmpegProcess = spawn(ffmpegBinary, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  sendRecordingEvent('started', {
    outputPath: currentOutputPath,
    message: `已开始录制（${mode === 'douyin' ? '抖音直播' : '通用直播流'}），正在写入本地文件。FFmpeg: ${ffmpegBinary}${ffmpegInfo.versionRaw ? ` (${ffmpegInfo.versionRaw})` : ''}`,
  });
  startProgressTicker();

  ffmpegProcess.stderr.on('data', processStderrChunk);

  ffmpegProcess.stdout.on('data', (chunk) => {
    const line = chunk.toString('utf8').trim();
    if (!line) {
      return;
    }

    rememberLog(line);
    sendRecordingEvent('log', { message: line });
  });

  ffmpegProcess.once('error', (error) => {
    sendRecordingEvent('error', {
      message: `ffmpeg 进程异常: ${error.message}`,
      outputPath: currentOutputPath,
    });
  });

  ffmpegProcess.once('close', (code, signal) => {
    stopProgressTicker();

    if (stderrRemainder.trim()) {
      handleStderrLine(stderrRemainder);
      stderrRemainder = '';
    }

    const outputPath = currentOutputPath;
    const fileSize = getFileSize(outputPath);
    const hasFile = fileSize > 0;

    let eventType = 'error';
    let message = '录制异常结束，请检查日志。';

    if (stopRequested) {
      eventType = 'stopped';
      if (stopReason === 'low_disk') {
        message = hasFile
          ? '磁盘剩余空间不足 10 GB，已自动停止录制并保存文件。'
          : '磁盘剩余空间不足 10 GB，已自动停止录制，但未检测到有效输出文件。';
      } else {
        message = hasFile
          ? '已停止录制，文件保存成功。'
          : '已停止录制，未检测到有效输出文件。';
      }
    } else if (code === 0 || hasWrittenFrames || hasFile) {
      eventType = 'ended';
      message = hasFile
        ? '直播流已结束或中断，录制文件已保存。'
        : '直播流已结束，但没有生成有效文件。';
    } else {
      const lastLog = ffmpegLogs[ffmpegLogs.length - 1] || '';
      message = `录制失败（退出码: ${code ?? 'null'}，信号: ${signal ?? 'none'}）。${lastLog}`;
    }

    ffmpegProcess = null;
    stopRequested = false;
    stopReason = '';
    hasWrittenFrames = false;
    currentOutputPath = '';
    lowDiskProtectionTriggered = false;

    sendRecordingEvent(eventType, {
      message,
      outputPath,
      fileSize,
      code,
      signal,
    });
  });

  return { outputPath: currentOutputPath };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function stopRecording(reason = 'manual') {
  if (!ffmpegProcess) {
    return { ok: false, message: '当前没有运行中的录制任务。' };
  }

  stopRequested = true;
  stopReason = reason;
  const processRef = ffmpegProcess;

  const closed = new Promise((resolve) => {
    processRef.once('close', () => resolve(true));
  });

  try {
    processRef.stdin.write('q\n');
  } catch {
    // ignore
  }

  let exited = await Promise.race([
    closed,
    wait(6000).then(() => false),
  ]);

  if (!exited) {
    processRef.kill('SIGINT');
    exited = await Promise.race([
      closed,
      wait(3000).then(() => false),
    ]);
  }

  if (!exited && !processRef.killed) {
    processRef.kill('SIGKILL');
  }

  return { ok: true, message: '正在停止录制...' };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 720,
    minHeight: 520,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

ipcMain.handle('recording:start', async (_event, startPayload) => {
  try {
    const { outputPath } = await startRecording(startPayload);
    return {
      ok: true,
      outputPath,
    };
  } catch (error) {
    return {
      ok: false,
      message: error.message,
    };
  }
});

ipcMain.handle('recording:stop', async () => {
  try {
    return await stopRecording();
  } catch (error) {
    return {
      ok: false,
      message: error.message,
    };
  }
});

ipcMain.handle('recording:open-folder', async (_event, outputPath) => {
  if (!outputPath) {
    return { ok: false, message: '缺少文件路径' };
  }

  if (fs.existsSync(outputPath)) {
    shell.showItemInFolder(outputPath);
    return { ok: true };
  }

  const openResult = await shell.openPath(path.dirname(outputPath));
  if (openResult) {
    return { ok: false, message: openResult };
  }

  return { ok: true };
});

ipcMain.handle('recording:get-settings', async () => {
  return {
    ok: true,
    outputDirectory: getOutputDirectory(),
  };
});

ipcMain.handle('recording:choose-output-dir', async () => {
  const currentDirectory = getOutputDirectory();
  const result = await dialog.showOpenDialog({
    title: '选择保存目录',
    defaultPath: currentDirectory,
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return {
      ok: false,
      canceled: true,
      outputDirectory: currentDirectory,
    };
  }

  try {
    const nextDirectory = setOutputDirectory(result.filePaths[0]);
    return {
      ok: true,
      outputDirectory: nextDirectory,
      message: '保存目录更新成功',
    };
  } catch (error) {
    return {
      ok: false,
      message: `保存目录不可用: ${error.message}`,
      outputDirectory: currentDirectory,
    };
  }
});

app.whenReady().then(() => {
  loadSettings();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  stopProgressTicker();
  if (ffmpegProcess && !ffmpegProcess.killed) {
    stopRequested = true;
    ffmpegProcess.kill('SIGTERM');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
