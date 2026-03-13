const streamUrlInput = document.getElementById('streamUrl');
const douyinPageUrlInput = document.getElementById('douyinPageUrl');
const tabGenericBtn = document.getElementById('tabGenericBtn');
const tabDouyinBtn = document.getElementById('tabDouyinBtn');
const panelGeneric = document.getElementById('panelGeneric');
const panelDouyin = document.getElementById('panelDouyin');

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const openBtn = document.getElementById('openBtn');
const chooseDirBtn = document.getElementById('chooseDirBtn');
const chooseFfmpegBtn = document.getElementById('chooseFfmpegBtn');
const statusTag = document.getElementById('statusTag');
const statusText = document.getElementById('statusText');
const outputPathText = document.getElementById('outputPath');
const outputDirText = document.getElementById('outputDir');
const ffmpegPathText = document.getElementById('ffmpegPath');
const ffmpegHint = document.getElementById('ffmpegHint');
const fileSizeText = document.getElementById('fileSize');
const diskFreeText = document.getElementById('diskFree');
const logsEl = document.getElementById('logs');

const defaultGenericUrl =
  'https://hw-origin.pull.yximgs.com/gifshow/_JxvDTzBYCo_GameAvcHdL0.flv?hwTime=6999d048&hwSecret=1fa93d3912eff5a9d2a5d589986e5bba&tsc=origin&oidc=edgeWm&sidc=204180&no_script=1&ss=s20&tfc_buyer=0&kabr_spts=-5000';

const defaultDouyinUrl =
  'https://live.douyin.com/43464444647?anchor_id=74996910208&category_name=all&is_vs=0&page_type=main_category_page&vs_ep_group_id=&vs_episode_id=&vs_episode_stage=&vs_season_id=';

if (streamUrlInput && !streamUrlInput.value.trim()) {
  streamUrlInput.value = defaultGenericUrl;
}

if (douyinPageUrlInput && !douyinPageUrlInput.value.trim()) {
  douyinPageUrlInput.value = defaultDouyinUrl;
}

let activeMode = 'generic';
let currentOutputPath = '';
let isRecording = false;
let requiresManualFfmpeg = false;
let configuredFfmpegPath = '';

const MAX_LOG_LINES = 600;
const MAX_LOG_CHARS = 80000;
const MAX_SINGLE_LOG_LENGTH = 1200;

function appendLog(message) {
  if (!message) {
    return;
  }

  const normalizedMessage = String(message).replace(/\r/g, ' ').trim();
  if (!normalizedMessage) {
    return;
  }

  const safeMessage = normalizedMessage.length > MAX_SINGLE_LOG_LENGTH
    ? `${normalizedMessage.slice(0, MAX_SINGLE_LOG_LENGTH)}...(日志已截断)`
    : normalizedMessage;

  const now = new Date();
  const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  logsEl.textContent += `[${stamp}] ${safeMessage}\n`;

  const lines = logsEl.textContent.split('\n');
  if (lines.length > MAX_LOG_LINES) {
    logsEl.textContent = `${lines.slice(-MAX_LOG_LINES).join('\n')}`;
  }

  if (logsEl.textContent.length > MAX_LOG_CHARS) {
    logsEl.textContent = logsEl.textContent.slice(-MAX_LOG_CHARS);
  }

  logsEl.scrollTop = logsEl.scrollHeight;
}

function formatBytes(bytes) {
  const safeBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
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

function getModeLabel(mode) {
  return mode === 'douyin' ? '抖音直播' : '通用直播流';
}

function setOutputDirectory(directoryPath) {
  outputDirText.textContent = directoryPath
    ? `保存目录: ${directoryPath}`
    : '保存目录: 未设置';
}

function setFfmpegPathDisplay(ffmpegPath) {
  configuredFfmpegPath = ffmpegPath || '';

  if (configuredFfmpegPath) {
    ffmpegPathText.textContent = `FFmpeg: ${configuredFfmpegPath}`;
    return;
  }

  ffmpegPathText.textContent = requiresManualFfmpeg
    ? 'FFmpeg: 未手动选择（将使用内置默认）'
    : 'FFmpeg: 自动检测';
}

function setFfmpegSelectorVisible(isVisible) {
  chooseFfmpegBtn.hidden = !isVisible;
  ffmpegHint.hidden = !isVisible;
}

function updateMetrics(fileSize, diskFree) {
  fileSizeText.textContent = `文件大小: ${formatBytes(fileSize)}`;
  diskFreeText.textContent = Number.isFinite(diskFree)
    ? `磁盘剩余: ${formatBytes(diskFree)}`
    : '磁盘剩余: --';
}

function setStatus(tag, text, mode = 'idle') {
  statusTag.textContent = tag;
  statusText.textContent = text;
  statusTag.classList.remove('running', 'error');

  if (mode === 'running') {
    statusTag.classList.add('running');
  }

  if (mode === 'error') {
    statusTag.classList.add('error');
  }
}

function applyActiveModeUI() {
  const isDouyin = activeMode === 'douyin';

  tabGenericBtn.classList.toggle('active', !isDouyin);
  tabDouyinBtn.classList.toggle('active', isDouyin);

  tabGenericBtn.setAttribute('aria-selected', String(!isDouyin));
  tabDouyinBtn.setAttribute('aria-selected', String(isDouyin));

  panelGeneric.classList.toggle('active', !isDouyin);
  panelDouyin.classList.toggle('active', isDouyin);

  panelGeneric.hidden = isDouyin;
  panelDouyin.hidden = !isDouyin;
}

function switchMode(nextMode) {
  if (nextMode !== 'generic' && nextMode !== 'douyin') {
    return;
  }

  if (isRecording) {
    appendLog('录制进行中，无法切换来源标签。');
    return;
  }

  if (activeMode === nextMode) {
    return;
  }

  activeMode = nextMode;
  applyActiveModeUI();
  setStatus('空闲中', `当前来源: ${getModeLabel(activeMode)}`);
  appendLog(`已切换到${getModeLabel(activeMode)}模式`);
}

function getActiveInputValue() {
  const input = activeMode === 'douyin' ? douyinPageUrlInput : streamUrlInput;
  return input ? input.value.trim() : '';
}

function syncButtons() {
  startBtn.disabled = isRecording;
  stopBtn.disabled = !isRecording;
  openBtn.disabled = !currentOutputPath;
  chooseDirBtn.disabled = isRecording;
  chooseFfmpegBtn.disabled = isRecording || !requiresManualFfmpeg;
  tabGenericBtn.disabled = isRecording;
  tabDouyinBtn.disabled = isRecording;
}

async function loadSettings() {
  const result = await window.recorderApi.getSettings();
  if (!result || !result.ok) {
    setOutputDirectory('');
    appendLog('读取保存目录失败，已使用默认目录。');
    return;
  }

  requiresManualFfmpeg = Boolean(result.requiresManualFfmpeg);
  setFfmpegSelectorVisible(requiresManualFfmpeg);
  setOutputDirectory(result.outputDirectory);
  setFfmpegPathDisplay(result.ffmpegPath || '');

  if (requiresManualFfmpeg && !configuredFfmpegPath) {
    appendLog('Windows 当前未手动选择 FFmpeg，将优先使用内置默认 FFmpeg。');
  }
}

startBtn.addEventListener('click', async () => {
  const url = getActiveInputValue();
  if (!url) {
    const hint = activeMode === 'douyin' ? '请先输入抖音直播页链接' : '请先输入直播流链接';
    setStatus('错误', hint, 'error');
    appendLog(hint);
    return;
  }

  startBtn.disabled = true;
  setStatus('启动中', '正在启动 ffmpeg...', 'running');
  appendLog(`开始录制（${getModeLabel(activeMode)}）: ${url}`);

  const result = await window.recorderApi.start({
    mode: activeMode,
    url,
  });

  if (!result.ok) {
    isRecording = false;
    syncButtons();
    setStatus('失败', result.message || '启动失败', 'error');
    appendLog(`启动失败: ${result.message || '未知错误'}`);
    return;
  }

  isRecording = true;
  currentOutputPath = result.outputPath || '';
  outputPathText.textContent = currentOutputPath
    ? `输出文件: ${currentOutputPath}`
    : '';
  updateMetrics(0, NaN);

  setStatus('录制中', `正在保存${getModeLabel(activeMode)}内容...`, 'running');
  syncButtons();
});

stopBtn.addEventListener('click', async () => {
  if (!isRecording) {
    return;
  }

  setStatus('停止中', '正在停止并写入尾部...', 'running');
  appendLog('用户请求停止录制');

  const result = await window.recorderApi.stop();
  if (!result.ok) {
    setStatus('失败', result.message || '停止失败', 'error');
    appendLog(`停止失败: ${result.message || '未知错误'}`);
    return;
  }

  appendLog(result.message || '停止命令已发送');
});

openBtn.addEventListener('click', async () => {
  if (!currentOutputPath) {
    return;
  }

  const result = await window.recorderApi.openFolder(currentOutputPath);
  if (!result.ok) {
    appendLog(`打开目录失败: ${result.message || '未知错误'}`);
    setStatus('失败', '打开目录失败', 'error');
  }
});

chooseDirBtn.addEventListener('click', async () => {
  const result = await window.recorderApi.chooseOutputDir();
  if (!result) {
    appendLog('选择保存目录失败: 未知错误');
    return;
  }

  if (result.ok) {
    setOutputDirectory(result.outputDirectory);
    appendLog(`保存目录已更新: ${result.outputDirectory}`);
    return;
  }

  if (result.canceled) {
    return;
  }

  if (result.outputDirectory) {
    setOutputDirectory(result.outputDirectory);
  }

  appendLog(`选择保存目录失败: ${result.message || '未知错误'}`);
  setStatus('失败', result.message || '选择保存目录失败', 'error');
});

chooseFfmpegBtn.addEventListener('click', async () => {
  if (!requiresManualFfmpeg) {
    return;
  }

  const result = await window.recorderApi.chooseFfmpeg();
  if (!result) {
    appendLog('选择 FFmpeg 失败: 未知错误');
    return;
  }

  if (result.ok) {
    setFfmpegPathDisplay(result.ffmpegPath);
    appendLog(
      `FFmpeg 已设置: ${result.ffmpegPath}${result.versionRaw ? ` (版本 ${result.versionRaw})` : ''}`
    );
    return;
  }

  if (result.canceled) {
    return;
  }

  if (result.ffmpegPath) {
    setFfmpegPathDisplay(result.ffmpegPath);
  }

  appendLog(result.message || '选择 FFmpeg 失败');
  setStatus('失败', result.message || '选择 FFmpeg 失败', 'error');
});

[streamUrlInput, douyinPageUrlInput].forEach((input) => {
  if (!input) {
    return;
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !isRecording) {
      startBtn.click();
    }
  });
});

tabGenericBtn.addEventListener('click', () => switchMode('generic'));
tabDouyinBtn.addEventListener('click', () => switchMode('douyin'));

window.recorderApi.onEvent((event) => {
  if (!event || !event.type) {
    return;
  }

  if (event.message && event.type !== 'log') {
    appendLog(event.message);
  }

  if (event.outputPath) {
    currentOutputPath = event.outputPath;
    outputPathText.textContent = `输出文件: ${currentOutputPath}`;
  }

  switch (event.type) {
    case 'started': {
      isRecording = true;
      setStatus('录制中', event.message || 'FFmpeg 已启动，正在拉流保存', 'running');
      break;
    }
    case 'log': {
      if (event.message) {
        appendLog(event.message);
      }
      break;
    }
    case 'progress': {
      updateMetrics(event.fileSize, event.diskFree);
      break;
    }
    case 'warning': {
      setStatus('警告', event.message || '磁盘空间不足，正在自动停止', 'error');
      break;
    }
    case 'stopped': {
      isRecording = false;
      setStatus('已停止', event.message || '录制已停止');
      break;
    }
    case 'ended': {
      isRecording = false;
      setStatus('已结束', event.message || '直播已结束');
      break;
    }
    case 'error': {
      isRecording = false;
      setStatus('异常', event.message || '录制异常', 'error');
      break;
    }
    default:
      break;
  }

  syncButtons();
});

applyActiveModeUI();
setFfmpegSelectorVisible(false);
setFfmpegPathDisplay('');
syncButtons();
updateMetrics(0, NaN);
loadSettings();
appendLog('应用已就绪，默认使用通用直播流模式。');
