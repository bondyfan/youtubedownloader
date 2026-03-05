import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

const urlInput = document.getElementById('url-input');
const analyzeBtn = document.getElementById('analyze-btn');
const statusText = document.getElementById('status-text');
const metaPanel = document.getElementById('meta-panel');
const formatsPanel = document.getElementById('formats-panel');
const titleEl = document.getElementById('title');
const metaEl = document.getElementById('meta');
const thumbEl = document.getElementById('thumb');
const videoList = document.getElementById('video-list');
const audioList = document.getElementById('audio-list');
const tpl = document.getElementById('format-template');

let currentUrl = '';
let currentTitle = '';
let desktopReady = false;

function formatDuration(totalSec) {
  if (!totalSec || Number.isNaN(totalSec)) return 'Unknown length';
  const s = Math.floor(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatBytes(n) {
  if (!n || Number.isNaN(n)) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = n;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size.toFixed(size >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function setStatus(msg, isError = false) {
  statusText.textContent = msg;
  statusText.classList.toggle('error', isError);
}

function clearFormats() {
  videoList.innerHTML = '';
  audioList.innerHTML = '';
}

function sanitizeFileName(name) {
  return (name || 'download')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function buildDefaultFileName(entry, kind) {
  const safeTitle = sanitizeFileName(currentTitle || 'download');
  const ext = kind === 'audio' ? (entry.ext === 'm4a' ? 'm4a' : 'mp3') : entry.ext;
  return `${safeTitle}.${ext}`;
}

async function chooseSavePath(entry, kind) {
  const ext = kind === 'audio' ? (entry.ext === 'm4a' ? 'm4a' : 'mp3') : entry.ext;
  return save({
    defaultPath: buildDefaultFileName(entry, kind),
    filters: [
      {
        name: kind === 'audio' ? 'Audio' : 'Video',
        extensions: [ext]
      }
    ]
  });
}

async function invokeWithTimeout(command, args, timeoutMs = 90000) {
  return Promise.race([
    invoke(command, args),
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs / 1000}s.`)), timeoutMs);
    })
  ]);
}

async function verifyDesktopTools() {
  try {
    const health = await invoke('health_check');
    if (!health.ytDlpFound || !health.ffmpegFound) {
      const missing = [];
      if (!health.ytDlpFound) missing.push('yt-dlp');
      if (!health.ffmpegFound) missing.push('ffmpeg');
      analyzeBtn.disabled = true;
      setStatus(`Missing local tools: ${missing.join(', ')}. Install with brew install yt-dlp ffmpeg.`, true);
      return;
    }

    desktopReady = true;
    analyzeBtn.disabled = false;
    setStatus('Ready');
  } catch (error) {
    analyzeBtn.disabled = true;
    setStatus(`Desktop bridge unavailable: ${error.message || 'unknown error'}`, true);
  }
}

async function triggerDownload(payload, entry, kind, buttonEl) {
  const savePath = await chooseSavePath(entry, kind);
  if (!savePath) {
    setStatus('Download cancelled.');
    return;
  }

  const prevText = buttonEl.textContent;
  buttonEl.textContent = 'Downloading...';
  buttonEl.disabled = true;

  try {
    const result = await invokeWithTimeout('download_media', {
      request: {
        ...payload,
        outputPath: savePath
      }
    }, 180000);

    setStatus(`Saved to ${result.savedPath}`);
  } catch (error) {
    setStatus(error.message || 'Download failed', true);
  } finally {
    buttonEl.textContent = prevText;
    buttonEl.disabled = false;
  }
}

function renderFormatCard(targetEl, entry, kind) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.label').textContent = entry.label;
  node.querySelector('.details').textContent = `Approx: ${formatBytes(entry.approxSize)}`;

  const btn = node.querySelector('.download-btn');
  btn.addEventListener('click', async () => {
    if (!currentUrl || !desktopReady) return;

    const payload = {
      url: currentUrl,
      type: kind,
      formatId: entry.id
    };

    if (kind === 'audio') {
      payload.audioCodec = entry.ext === 'm4a' ? 'm4a' : 'mp3';
    }

    await triggerDownload(payload, entry, kind, btn);
  });

  targetEl.appendChild(node);
}

function renderVideoFormats(list) {
  const mp4 = list.filter((f) => f.ext === 'mp4' && f.height <= 1080);
  const others = list.filter((f) => !(f.ext === 'mp4' && f.height <= 1080));
  const ordered = [...mp4, ...others];

  if (!ordered.length) {
    videoList.innerHTML = '<p class="hint">No video formats were found.</p>';
    return;
  }

  ordered.forEach((format) => renderFormatCard(videoList, format, 'video'));
}

function renderAudioFormats(list) {
  if (!list.length) {
    audioList.innerHTML = '<p class="hint">No audio formats were found.</p>';
    return;
  }

  list.forEach((format) => renderFormatCard(audioList, format, 'audio'));
}

async function analyze() {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus('Please paste a YouTube URL.', true);
    return;
  }

  if (!desktopReady) {
    setStatus('Desktop runtime is not ready yet.', true);
    return;
  }

  clearFormats();
  currentUrl = '';
  currentTitle = '';
  analyzeBtn.disabled = true;
  setStatus('Analyzing formats...');

  try {
    const payload = await invokeWithTimeout('analyze_url', { url });

    currentUrl = url;
    currentTitle = payload.title || 'Untitled';
    titleEl.textContent = payload.title || 'Untitled';
    const uploader = payload.uploader ? `by ${payload.uploader}` : 'Unknown channel';
    metaEl.textContent = `${uploader} • ${formatDuration(payload.duration)}`;
    thumbEl.src = payload.thumbnail || '';
    thumbEl.alt = payload.title || 'thumbnail';

    metaPanel.classList.remove('hidden');
    formatsPanel.classList.remove('hidden');

    renderVideoFormats(payload.videoFormats || []);
    renderAudioFormats(payload.audioFormats || []);

    setStatus('Select format and choose where to save it.');
  } catch (error) {
    setStatus(error.message || 'Analysis failed.', true);
    metaPanel.classList.add('hidden');
    formatsPanel.classList.add('hidden');
  } finally {
    analyzeBtn.disabled = false;
  }
}

analyzeBtn.disabled = true;
analyzeBtn.addEventListener('click', analyze);
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') analyze();
});

verifyDesktopTools();
