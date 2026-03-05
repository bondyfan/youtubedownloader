const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

admin.initializeApp();

const YOUTUBE_URL_RE = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/i;
const YT_DLP_BIN = path.join(os.tmpdir(), 'yt-dlp');
const ytDlp = new YTDlpWrap(YT_DLP_BIN);
let ytDlpReadyPromise = null;

function sanitizeFileName(name) {
  return (name || 'download')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'Unknown error');
}

function pickVideoFormats(formats) {
  const candidates = formats
    .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height && f.height <= 2160)
    .filter((f) => !(f.format_note || '').toLowerCase().includes('storyboard'));

  const seen = new Set();
  const result = [];

  for (const fmt of candidates) {
    const ext = fmt.ext || 'unknown';
    const fps = fmt.fps || 30;
    const key = `${fmt.height}-${ext}-${fps}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const streamType = fmt.acodec && fmt.acodec !== 'none' ? 'single' : 'video-only';
    result.push({
      id: fmt.format_id,
      ext,
      height: fmt.height,
      fps,
      streamType,
      label: `${fmt.height}p ${ext.toUpperCase()}${fps > 30 ? ` ${fps}fps` : ''}${
        streamType === 'video-only' ? ' (merged with best audio)' : ''
      }`,
      approxSize: fmt.filesize || fmt.filesize_approx || null
    });
  }

  return result.sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    if (a.ext !== b.ext) return a.ext.localeCompare(b.ext);
    return (b.fps || 0) - (a.fps || 0);
  });
}

function pickAudioFormats(formats) {
  const candidates = formats
    .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .filter((f) => f.abr || f.asr || f.audio_ext || f.ext);

  const seen = new Set();
  const result = [];

  for (const fmt of candidates) {
    const ext = fmt.audio_ext && fmt.audio_ext !== 'none' ? fmt.audio_ext : fmt.ext || 'audio';
    const abr = Math.round(fmt.abr || 0);
    const key = `${ext}-${abr}`;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({
      id: fmt.format_id,
      ext,
      abr,
      label: `${ext.toUpperCase()}${abr ? ` ~${abr}kbps` : ''}`,
      approxSize: fmt.filesize || fmt.filesize_approx || null
    });
  }

  return result.sort((a, b) => {
    if ((b.abr || 0) !== (a.abr || 0)) return (b.abr || 0) - (a.abr || 0);
    return a.ext.localeCompare(b.ext);
  });
}

async function ensureYtDlpBinary() {
  if (fs.existsSync(YT_DLP_BIN)) return;
  if (!ytDlpReadyPromise) {
    ytDlpReadyPromise = (async () => {
      logger.info('Downloading yt-dlp binary...');
      await YTDlpWrap.downloadFromGithub(YT_DLP_BIN);
      fs.chmodSync(YT_DLP_BIN, 0o755);
      logger.info('yt-dlp binary ready.');
    })();
  }
  await ytDlpReadyPromise;
}

async function getVideoInfo(url) {
  await ensureYtDlpBinary();
  const info = await ytDlp.getVideoInfo(url);
  return info;
}

async function downloadToTemp({ url, type, formatId, audioCodec }) {
  await ensureYtDlpBinary();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-download-'));
  const outTemplate = path.join(tempDir, '%(title)s.%(ext)s');

  const args = ['--no-playlist', '--newline', '-o', outTemplate, '-f'];

  if (type === 'video') {
    args.push(`${formatId}+bestaudio/best`);
  } else {
    args.push(formatId);
    args.push('--extract-audio', '--audio-format', audioCodec || 'mp3', '--audio-quality', '0');
  }

  args.push('--ffmpeg-location', ffmpegInstaller.path);
  args.push('--print', 'after_move:filepath');
  args.push(url);

  const output = await ytDlp.execPromise(args);
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const filePath = lines[lines.length - 1] || '';

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Download finished but output file was not found.');
  }

  return { tempDir, filePath };
}

function getRoutePath(req) {
  const raw = req.path || req.url || '/';
  if (raw.startsWith('/api/')) return raw.slice(4);
  if (raw === '/api') return '/';
  return raw;
}

function sendJson(res, status, payload) {
  res.status(status);
  res.set('Content-Type', 'application/json');
  res.send(JSON.stringify(payload));
}

exports.api = onRequest(
  {
    region: 'us-central1',
    timeoutSeconds: 540,
    memory: '1GiB'
  },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    try {
      const route = getRoutePath(req);

      if (route === '/health' && req.method === 'GET') {
        await ensureYtDlpBinary();
        return sendJson(res, 200, { ok: true });
      }

      if (route === '/info' && req.method === 'POST') {
        const { url } = req.body || {};

        if (!url || typeof url !== 'string' || !YOUTUBE_URL_RE.test(url)) {
          return sendJson(res, 400, { message: 'Provide a valid YouTube URL.' });
        }

        const data = await getVideoInfo(url);
        const formats = Array.isArray(data.formats) ? data.formats : [];
        const videoFormats = pickVideoFormats(formats);
        const audioFormats = pickAudioFormats(formats);

        if (!videoFormats.length && !audioFormats.length) {
          return sendJson(res, 422, { message: 'No downloadable formats were found.' });
        }

        return sendJson(res, 200, {
          id: data.id,
          title: data.title || 'Untitled',
          uploader: data.uploader || null,
          thumbnail: data.thumbnail || null,
          duration: data.duration || null,
          videoFormats,
          audioFormats
        });
      }

      if (route === '/download' && req.method === 'POST') {
        const { url, type, formatId, audioCodec } = req.body || {};

        if (!url || typeof url !== 'string' || !YOUTUBE_URL_RE.test(url)) {
          return sendJson(res, 400, { message: 'Provide a valid YouTube URL.' });
        }

        if (!['video', 'audio'].includes(type)) {
          return sendJson(res, 400, { message: 'Invalid download type.' });
        }

        if (!formatId || typeof formatId !== 'string') {
          return sendJson(res, 400, { message: 'Choose a specific format.' });
        }

        const { tempDir, filePath } = await downloadToTemp({
          url,
          type,
          formatId,
          audioCodec: typeof audioCodec === 'string' ? audioCodec : 'mp3'
        });

        try {
          const ext = path.extname(filePath);
          const base = sanitizeFileName(path.basename(filePath, ext));
          const fileName = `${base}${ext}`;

          const random = crypto.randomBytes(6).toString('hex');
          const destination = `downloads/${Date.now()}-${random}-${fileName}`;

          const bucket = admin.storage().bucket();
          await bucket.upload(filePath, {
            destination,
            metadata: {
              contentDisposition: `attachment; filename=\"${fileName}\"`
            }
          });

          const file = bucket.file(destination);
          const expires = Date.now() + 15 * 60 * 1000;

          const [downloadUrl] = await file.getSignedUrl({
            action: 'read',
            expires,
            responseDisposition: `attachment; filename=\"${fileName}\"`
          });

          return sendJson(res, 200, {
            downloadUrl,
            fileName,
            expiresAt: new Date(expires).toISOString()
          });
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }

      return sendJson(res, 404, { message: 'Not found' });
    } catch (error) {
      logger.error('API error', error);
      return sendJson(res, 500, {
        message: 'Request failed.',
        details: formatError(error)
      });
    }
  }
);
