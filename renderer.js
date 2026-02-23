const streamUrlInput = document.getElementById('streamUrl');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const openBtn = document.getElementById('openBtn');
const chooseDirBtn = document.getElementById('chooseDirBtn');
const statusTag = document.getElementById('statusTag');
const statusText = document.getElementById('statusText');
const outputPathText = document.getElementById('outputPath');
const outputDirText = document.getElementById('outputDir');
const fileSizeText = document.getElementById('fileSize');
const diskFreeText = document.getElementById('diskFree');
const logsEl = document.getElementById('logs');

const defaultUrl =
  'https://hw-origin.pull.yximgs.com/gifshow/_JxvDTzBYCo_GameAvcHdL0.flv?hwTime=6999d048&hwSecret=1fa93d3912eff5a9d2a5d589986e5bba&tsc=origin&oidc=edgeWm&sidc=204180&no_script=1&ss=s20&tfc_buyer=0&kabr_spts=-5000';

streamUrlInput.value = defaultUrl;

let currentOutputPath = '';
let isRecording = false;
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

function setOutputDirectory(directoryPath) {
  outputDirText.textContent = directoryPath
    ? `保存目录: ${directoryPath}`
    : '保存目录: 未设置';
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

function syncButtons() {
  startBtn.disabled = isRecording;
  stopBtn.disabled = !isRecording;
  openBtn.disabled = !currentOutputPath;
  chooseDirBtn.disabled = isRecording;
}

async function loadSettings() {
  const result = await window.recorderApi.getSettings();
  if (!result || !result.ok) {
    setOutputDirectory('');
    appendLog('读取保存目录失败，已使用默认目录。');
    return;
  }

  setOutputDirectory(result.outputDirectory);
}

startBtn.addEventListener('click', async () => {
  const url = streamUrlInput.value.trim();
  if (!url) {
    setStatus('错误', '请先输入直播链接', 'error');
    appendLog('请先输入直播链接');
    return;
  }

  startBtn.disabled = true;
  setStatus('启动中', '正在启动 ffmpeg...', 'running');
  appendLog(`开始录制: ${url}`);

  const result = await window.recorderApi.start(url);
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

  setStatus('录制中', '正在保存直播流...', 'running');
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
      setStatus('录制中', 'FFmpeg 已启动，正在拉流保存', 'running');
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

syncButtons();
updateMetrics(0, NaN);
loadSettings();
appendLog('应用已就绪，等待输入直播链接。');
