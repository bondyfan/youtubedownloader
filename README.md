# YouTube Downloader (Firebase)

Modern YouTube downloader UI deployed with Firebase Hosting + Cloud Functions.

## Architecture

- `public/` is a static frontend (Hosting).
- `functions/` provides API endpoints:
  - `POST /api/info` - analyze URL and return formats
  - `POST /api/download` - download selected format, upload to Cloud Storage, return signed URL
  - `GET /api/health` - runtime check

This avoids a dedicated long-running server (`server.js` removed).

## Requirements

- Node.js 20+
- Firebase CLI (`npm i -g firebase-tools`)
- Firebase project already configured (`downloader-a0f61`)

## Install

```bash
npm --prefix functions install
```

## Local development (recommended)

```bash
npm install
npm --prefix functions install
npm run dev
```

Then open `http://localhost:5173`.

`npm run dev` starts:
- Vite frontend dev server
- Firebase Functions emulator (API backend)

The Vite proxy forwards `/api/*` to the local Functions emulator.

## Full Firebase emulator suite

```bash
firebase emulators:start
```

## Local requirements for downloads

- `yt-dlp` must be installed and available in `PATH`
- `ffmpeg` must be installed and available in `PATH`

Example on macOS (Homebrew):

```bash
brew install yt-dlp ffmpeg
```

## Deploy

```bash
firebase deploy
```

or separately:

```bash
firebase deploy --only functions
firebase deploy --only hosting
```

## Important notes

- The function downloads `yt-dlp` binary to temp storage on cold start.
- `ffmpeg` binary is bundled via `@ffmpeg-installer/ffmpeg`.
- Download endpoint returns a signed Cloud Storage URL (15 min expiration).
- Configure Cloud Storage lifecycle rules if you want automatic cleanup of `downloads/` objects.
- Use responsibly and respect YouTube Terms and local copyright laws.
