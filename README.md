# YouTube Downloader Desktop

Local macOS desktop app built with Vite + Tauri. Downloads run on the user's Mac via local `yt-dlp` and `ffmpeg`, which avoids the cloud IP bot checks that were breaking the Firebase version.

## Requirements

- macOS
- Node.js 18+
- Rust toolchain via `rustup`
- `yt-dlp` in `PATH`
- `ffmpeg` in `PATH`

Install the media tools on macOS:

```bash
brew install yt-dlp ffmpeg
```

Install Rust:

```bash
curl https://sh.rustup.rs -sSf | sh
```

## Development

```bash
npm install
npm run desktop:dev
```

This starts Vite for the frontend and a Tauri window for the desktop shell.

## Build

```bash
npm run desktop:build
```

## Current structure

- `public/`: frontend UI
- `src-tauri/`: desktop shell and native commands
- `functions/`: previous Firebase backend, kept for reference and migration history

## Notes

- The desktop app expects local `yt-dlp` and `ffmpeg`.
- Downloads are saved to a location chosen by the user through the native save dialog.
- Rust is not installed in the current workspace environment, so the desktop bundle could not be built here yet.
