const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const LOW_DISK_THRESHOLD_BYTES = 10 * 1024 * 1024 * 1024;

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

function resolveFfmpegBinary() {
  const bundledPath = getBundledFfmpegPath();
  if (bundledPath) {
    return bundledPath;
  }

  const developmentPath = getDevelopmentFfmpegPath();
  if (developmentPath) {
    return developmentPath;
  }

  return 'ffmpeg';
}

function checkFfmpegAvailable() {
  const ffmpegBinary = resolveFfmpegBinary();

  return new Promise((resolve, reject) => {
    const probe = spawn(ffmpegBinary, ['-version']);

    probe.once('error', (error) => {
      reject(
        new Error(
          `找不到可用 FFmpeg。请确认打包产物包含 ffmpeg，或系统 PATH 可执行 ffmpeg。${error.message}`
        )
      );
    });

    probe.once('close', (code) => {
      if (code === 0) {
        resolve(ffmpegBinary);
        return;
      }

      reject(new Error(`ffmpeg 检查失败，退出码: ${code}`));
    });
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

async function startRecording(streamUrl) {
  if (!streamUrl) {
    throw new Error('请输入直播链接');
  }

  if (ffmpegProcess) {
    throw new Error('当前已有录制任务在运行');
  }

  const ffmpegBinary = await checkFfmpegAvailable();

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
    streamUrl,
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
    message: `已开始录制，正在写入本地文件。FFmpeg: ${ffmpegBinary}`,
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

ipcMain.handle('recording:start', async (_event, streamUrl) => {
  try {
    const { outputPath } = await startRecording(streamUrl);
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
