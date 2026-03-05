import { initFirebase } from './firebase-client.js';

initFirebase();

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

async function readApiPayload(res) {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return res.json();
  }
  const text = await res.text();
  return { message: text || `HTTP ${res.status}` };
}

function extractErrorMessage(payload, fallback) {
  if (!payload) return fallback;
  if (payload.details) return `${payload.message || fallback} ${payload.details}`.trim();
  return payload.message || fallback;
}

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

async function triggerDownload(payload, buttonEl) {
  const prevText = buttonEl.textContent;
  buttonEl.textContent = 'Preparing...';
  buttonEl.disabled = true;

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await readApiPayload(res);

    if (!res.ok) {
      throw new Error(extractErrorMessage(data, 'Download failed'));
    }

    if (!data.downloadUrl) {
      throw new Error('Download URL is missing in server response.');
    }

    const a = document.createElement('a');
    a.href = data.downloadUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus(`Download ready: ${data.fileName || 'file'}`);
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
  btn.addEventListener('click', () => {
    if (!currentUrl) return;
    const payload = {
      url: currentUrl,
      type: kind,
      formatId: entry.id
    };

    if (kind === 'audio') {
      payload.audioCodec = entry.ext === 'm4a' ? 'm4a' : 'mp3';
    }

    triggerDownload(payload, btn);
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

  clearFormats();
  currentUrl = '';
  analyzeBtn.disabled = true;
  setStatus('Analyzing formats...');

  try {
    const res = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    const payload = await readApiPayload(res);

    if (!res.ok) {
      throw new Error(extractErrorMessage(payload, 'Could not analyze this URL.'));
    }

    currentUrl = url;
    titleEl.textContent = payload.title || 'Untitled';
    const uploader = payload.uploader ? `by ${payload.uploader}` : 'Unknown channel';
    metaEl.textContent = `${uploader} • ${formatDuration(payload.duration)}`;
    thumbEl.src = payload.thumbnail || '';
    thumbEl.alt = payload.title || 'thumbnail';

    metaPanel.classList.remove('hidden');
    formatsPanel.classList.remove('hidden');

    renderVideoFormats(payload.videoFormats || []);
    renderAudioFormats(payload.audioFormats || []);

    setStatus('Select format and press download.');
  } catch (error) {
    setStatus(error.message || 'Analysis failed.', true);
    metaPanel.classList.add('hidden');
    formatsPanel.classList.add('hidden');
  } finally {
    analyzeBtn.disabled = false;
  }
}

analyzeBtn.addEventListener('click', analyze);
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') analyze();
});
