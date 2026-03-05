use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;
use tempfile::tempdir;

const YT_DLP_BIN: &str = "yt-dlp";
const FFMPEG_BIN: &str = "ffmpeg";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthStatus {
    yt_dlp_found: bool,
    ffmpeg_found: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FormatOption {
    id: String,
    ext: String,
    height: Option<u64>,
    fps: Option<u64>,
    abr: Option<u64>,
    stream_type: Option<String>,
    label: String,
    approx_size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoInfo {
    id: Option<String>,
    title: String,
    uploader: Option<String>,
    thumbnail: Option<String>,
    duration: Option<u64>,
    video_formats: Vec<FormatOption>,
    audio_formats: Vec<FormatOption>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadRequest {
    url: String,
    #[serde(rename = "type")]
    media_type: String,
    format_id: String,
    audio_codec: Option<String>,
    output_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadResult {
    saved_path: String,
}

fn normalize_youtube_url(raw: &str) -> String {
    if let Some(id) = raw.split("youtu.be/").nth(1) {
        let video_id = id.split(['?', '&', '/']).next().unwrap_or(id);
        return format!("https://www.youtube.com/watch?v={video_id}");
    }

    if raw.contains("youtube.com") {
        if let Some((_, query)) = raw.split_once('?') {
            for pair in query.split('&') {
                if let Some((key, value)) = pair.split_once('=') {
                    if key == "v" && !value.is_empty() {
                        return format!("https://www.youtube.com/watch?v={value}");
                    }
                }
            }
        }
    }

    raw.to_string()
}

fn tool_available(bin: &str) -> bool {
    Command::new(bin)
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn run_command(bin: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new(bin)
        .args(args)
        .output()
        .map_err(|err| format!("Failed to start {bin}: {err}"))?;

    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn run_yt_dlp_json(url: &str) -> Result<Value, String> {
    let normalized = normalize_youtube_url(url);
    let stdout = run_command(
        YT_DLP_BIN,
        &[
            "--no-playlist",
            "--extractor-args",
            "youtube:player_client=ios,web,tv",
            "--dump-single-json",
            "--no-warnings",
            &normalized,
        ],
    )?;

    serde_json::from_slice(&stdout).map_err(|err| format!("Invalid yt-dlp JSON response: {err}"))
}

fn get_str(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(|v| v.to_string())
}

fn get_u64(value: &Value, key: &str) -> Option<u64> {
    value.get(key)?.as_u64()
}

fn pick_video_formats(formats: &[Value]) -> Vec<FormatOption> {
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for fmt in formats {
        let vcodec = get_str(fmt, "vcodec").unwrap_or_default();
        let height = get_u64(fmt, "height");
        let ext = get_str(fmt, "ext").unwrap_or_else(|| "unknown".to_string());
        let fps = get_u64(fmt, "fps").or(Some(30));
        let format_note = get_str(fmt, "format_note").unwrap_or_default().to_lowercase();

        if vcodec == "none" || height.is_none() || height.unwrap_or_default() > 2160 {
            continue;
        }

        if format_note.contains("storyboard") {
            continue;
        }

        let key = format!(
            "{}-{}-{}",
            height.unwrap_or_default(),
            ext,
            fps.unwrap_or_default()
        );
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);

        let acodec = get_str(fmt, "acodec").unwrap_or_default();
        let stream_type = if acodec.is_empty() || acodec == "none" {
            "video-only"
        } else {
            "single"
        };
        let format_id = get_str(fmt, "format_id").unwrap_or_default();
        let label = if fps.unwrap_or_default() > 30 {
            format!(
                "{}p {} {}fps{}",
                height.unwrap_or_default(),
                ext.to_uppercase(),
                fps.unwrap_or_default(),
                if stream_type == "video-only" {
                    " (merged with best audio)"
                } else {
                    ""
                }
            )
        } else {
            format!(
                "{}p {}{}",
                height.unwrap_or_default(),
                ext.to_uppercase(),
                if stream_type == "video-only" {
                    " (merged with best audio)"
                } else {
                    ""
                }
            )
        };

        result.push(FormatOption {
            id: format_id,
            ext,
            height,
            fps,
            abr: None,
            stream_type: Some(stream_type.to_string()),
            label,
            approx_size: get_u64(fmt, "filesize").or_else(|| get_u64(fmt, "filesize_approx")),
        });
    }

    result.sort_by(|a, b| {
        b.height
            .cmp(&a.height)
            .then_with(|| a.ext.cmp(&b.ext))
            .then_with(|| b.fps.cmp(&a.fps))
    });

    result
}

fn pick_audio_formats(formats: &[Value]) -> Vec<FormatOption> {
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for fmt in formats {
        let acodec = get_str(fmt, "acodec").unwrap_or_default();
        let vcodec = get_str(fmt, "vcodec").unwrap_or_default();
        if acodec.is_empty() || acodec == "none" || (!vcodec.is_empty() && vcodec != "none") {
            continue;
        }

        let ext = get_str(fmt, "audio_ext")
            .filter(|value| value != "none")
            .or_else(|| get_str(fmt, "ext"))
            .unwrap_or_else(|| "audio".to_string());
        let abr = get_u64(fmt, "abr");
        let key = format!("{}-{}", ext, abr.unwrap_or_default());
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);

        let label = if let Some(rate) = abr {
            format!("{} ~{}kbps", ext.to_uppercase(), rate)
        } else {
            ext.to_uppercase()
        };

        result.push(FormatOption {
            id: get_str(fmt, "format_id").unwrap_or_default(),
            ext,
            height: None,
            fps: None,
            abr,
            stream_type: None,
            label,
            approx_size: get_u64(fmt, "filesize").or_else(|| get_u64(fmt, "filesize_approx")),
        });
    }

    result.sort_by(|a, b| b.abr.cmp(&a.abr).then_with(|| a.ext.cmp(&b.ext)));
    result
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create destination folder {}: {err}", parent.display()))
    } else {
        Ok(())
    }
}

#[tauri::command]
fn health_check() -> HealthStatus {
    HealthStatus {
        yt_dlp_found: tool_available(YT_DLP_BIN),
        ffmpeg_found: tool_available(FFMPEG_BIN),
    }
}

#[tauri::command]
fn analyze_url(url: String) -> Result<VideoInfo, String> {
    if !tool_available(YT_DLP_BIN) {
        return Err("yt-dlp is not installed or not available in PATH.".to_string());
    }

    let json = run_yt_dlp_json(&url)?;
    let formats = json
        .get("formats")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    let video_formats = pick_video_formats(&formats);
    let audio_formats = pick_audio_formats(&formats);

    if video_formats.is_empty() && audio_formats.is_empty() {
        return Err("No downloadable formats were found.".to_string());
    }

    Ok(VideoInfo {
        id: get_str(&json, "id"),
        title: get_str(&json, "title").unwrap_or_else(|| "Untitled".to_string()),
        uploader: get_str(&json, "uploader"),
        thumbnail: get_str(&json, "thumbnail"),
        duration: get_u64(&json, "duration"),
        video_formats,
        audio_formats,
    })
}

#[tauri::command]
fn download_media(request: DownloadRequest) -> Result<DownloadResult, String> {
    if !tool_available(YT_DLP_BIN) {
        return Err("yt-dlp is not installed or not available in PATH.".to_string());
    }

    if !tool_available(FFMPEG_BIN) {
        return Err("ffmpeg is not installed or not available in PATH.".to_string());
    }

    let normalized_url = normalize_youtube_url(&request.url);
    let output_path = PathBuf::from(&request.output_path);
    ensure_parent_dir(&output_path)?;

    let temp_dir = tempdir().map_err(|err| format!("Failed to create temp directory: {err}"))?;
    let output_template = temp_dir.path().join("%(title)s.%(ext)s");
    let output_template = output_template.to_string_lossy().to_string();

    let mut args = vec![
        "--no-playlist".to_string(),
        "--newline".to_string(),
        "--extractor-args".to_string(),
        "youtube:player_client=ios,web,tv".to_string(),
        "-o".to_string(),
        output_template,
        "-f".to_string(),
    ];

    if request.media_type == "video" {
        args.push(format!("{}+bestaudio/best", request.format_id));
    } else {
        args.push(request.format_id.clone());
        args.push("--extract-audio".to_string());
        args.push("--audio-format".to_string());
        args.push(request.audio_codec.unwrap_or_else(|| "mp3".to_string()));
        args.push("--audio-quality".to_string());
        args.push("0".to_string());
    }

    args.push("--ffmpeg-location".to_string());
    args.push(FFMPEG_BIN.to_string());
    args.push("--print".to_string());
    args.push("after_move:filepath".to_string());
    args.push(normalized_url);

    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = run_command(YT_DLP_BIN, &args_ref)?;
    let output = String::from_utf8_lossy(&stdout);
    let source_path = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .last()
        .ok_or_else(|| "Download finished but output file was not found.".to_string())?;
    let source_path = PathBuf::from(source_path);

    if !source_path.exists() {
        return Err("Download finished but output file was not found.".to_string());
    }

    fs::copy(&source_path, &output_path).map_err(|err| {
        format!(
            "Failed to save file to {}: {err}",
            output_path.display()
        )
    })?;

    Ok(DownloadResult {
        saved_path: output_path.display().to_string(),
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![health_check, analyze_url, download_media])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("YouTube Downloader");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
