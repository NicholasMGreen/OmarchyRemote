//! Host-only transcription adapters. Client input is audio, never a command or a host path.
use crate::{ApiError, apps, error};
use axum::{Json, body::Bytes, http::StatusCode};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::DirBuilderExt, path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, sync::Semaphore};

pub const MAX_BYTES: usize = 12 * 1024 * 1024;
static JOBS: Semaphore = Semaphore::const_new(1);

fn adapter(value: Option<String>) -> anyhow::Result<(Vec<String>, bool)> {
    let custom = value.is_some();
    let args: Vec<String> = match value {
        Some(value) => serde_json::from_str(&value)?,
        None => vec![
            "voxtype".into(),
            "--quiet".into(),
            "transcribe".into(),
            "{audio}".into(),
        ],
    };
    anyhow::ensure!(
        !args.is_empty() && !args[0].is_empty() && args.iter().skip(1).any(|a| a == "{audio}"),
        "OMARCHY_DICTATION_COMMAND must be a JSON argument array containing {{audio}}"
    );
    Ok((args, custom))
}
fn configured() -> anyhow::Result<(Vec<String>, bool)> {
    adapter(std::env::var("OMARCHY_DICTATION_COMMAND").ok())
}
pub async fn status() -> Json<Value> {
    let (available, provider, message) = match configured() {
        Ok((args, custom)) => {
            let ready = apps::resolve_program(&args[0]).is_ok_and(|path| path.is_file())
                && apps::resolve_program("ffmpeg").is_ok();
            (
                ready,
                if custom { "Custom command" } else { "Voxtype" },
                if ready {
                    "Ready"
                } else {
                    "Install the transcription command and ffmpeg on this host"
                },
            )
        }
        Err(_) => (
            false,
            "Custom command",
            "Invalid host dictation command configuration",
        ),
    };
    Json(json!({"available":available,"provider":provider,"message":message,"max_seconds":120}))
}
pub(crate) struct AudioDir(pub(crate) PathBuf);
impl AudioDir {
    pub(crate) fn new() -> anyhow::Result<Self> {
        let path = std::env::temp_dir().join(format!("omarchy-dictation-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self(path))
    }
}
impl Drop for AudioDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
// Kill the whole adapter process group on timeout, cancellation, and completion.
struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}
pub(crate) async fn execute(args: &[String], seconds: u64) -> anyhow::Result<String> {
    let executable = apps::resolve_program(&args[0])?;
    let mut child = Command::new(executable)
        .args(&args[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()?;
    let _group = ProcessGroup(
        child
            .id()
            .ok_or_else(|| anyhow::anyhow!("Transcriber did not start"))?,
    );
    let mut stdout = child.stdout.take().unwrap().take(65537);
    let mut stderr = child.stderr.take().unwrap().take(65537);
    tokio::time::timeout(Duration::from_secs(seconds), async {
        let mut text = Vec::new();
        let mut diagnostic = Vec::new();
        let (out, err, status) = tokio::join!(
            stdout.read_to_end(&mut text),
            stderr.read_to_end(&mut diagnostic),
            child.wait()
        );
        out?;
        err?;
        anyhow::ensure!(
            status?.success(),
            "Transcription command failed; check its configuration and model on the host"
        );
        anyhow::ensure!(
            text.len() <= 65536 && diagnostic.len() <= 65536,
            "Transcription command output is too large"
        );
        Ok(String::from_utf8(text)?)
    })
    .await
    .map_err(|_| anyhow::anyhow!("Transcription timed out"))?
}
fn transcript(output: String, custom: bool) -> anyhow::Result<String> {
    // Voxtype's file subcommand prints a diagnostic preamble even with --quiet.
    // The transcript follows a blank line; custom adapters return plain text only.
    let text = if custom {
        output.trim()
    } else if output
        .trim_end()
        .ends_with("No speech detected, skipping transcription.")
    {
        ""
    } else {
        output
            .split_once("\n\n")
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Unexpected Voxtype output; use a compatible version or a custom adapter"
                )
            })?
            .1
            .trim()
    };
    Ok(text.to_owned())
}
pub async fn transcribe(body: Bytes) -> Result<Json<Value>, ApiError> {
    let _permit = JOBS.try_acquire().map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"Another dictation is transcribing; try again shortly"})),
        )
    })?;
    if body.is_empty() || body.len() > MAX_BYTES {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"Empty or oversized audio"})),
        ));
    }
    let format = if body.starts_with(b"RIFF") && body.get(8..12) == Some(b"WAVE") {
        "wav"
    } else if body.get(4..8) == Some(b"ftyp") {
        "mov"
    } else if body.starts_with(b"\x1a\x45\xdf\xa3") {
        "matroska"
    } else if body.starts_with(b"OggS") {
        "ogg"
    } else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"Unsupported recording format"})),
        ));
    };
    let (mut args, custom) = configured().map_err(error)?;
    let dir = AudioDir::new().map_err(error)?;
    let source = dir.0.join("recording");
    let wav = dir.0.join("audio.wav");
    tokio::fs::write(&source, body).await.map_err(error)?;
    // Decode only local uploaded bytes, with bounded duration. No remote playlists or URLs.
    execute(
        &[
            "ffmpeg".into(),
            "-nostdin".into(),
            "-v".into(),
            "error".into(),
            "-protocol_whitelist".into(),
            "file,pipe".into(),
            "-f".into(),
            format.into(),
            "-i".into(),
            source.to_string_lossy().into(),
            "-t".into(),
            "121".into(),
            "-vn".into(),
            "-ac".into(),
            "1".into(),
            "-ar".into(),
            "16000".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            wav.to_string_lossy().into(),
        ],
        30,
    )
    .await
    .map_err(error)?;
    if tokio::fs::metadata(&wav).await.map_err(error)?.len() > 120 * 32000 + 128 {
        return Err(error("Recording exceeds two minutes"));
    }
    for arg in args.iter_mut().skip(1) {
        if arg == "{audio}" {
            *arg = wav.to_string_lossy().into();
        }
    }
    let text = transcript(execute(&args, 180).await.map_err(error)?, custom).map_err(error)?;
    Ok(Json(json!({"text":text})))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_contract() {
        assert!(adapter(Some("echo hello".into())).is_err());
        assert!(adapter(Some("[\"tool\"]".into())).is_err());
        let (args, custom) = adapter(Some(r#"["my adapter","--file","{audio}"]"#.into())).unwrap();
        assert!(custom);
        assert_eq!(args[0], "my adapter");
        assert!(!adapter(None).unwrap().1);
    }
    #[test]
    fn clean_transcripts() {
        assert_eq!(
            transcript(
                "Loading audio file: x\nProcessing 100 samples\n\nHello\nworld\n".into(),
                false
            )
            .unwrap(),
            "Hello\nworld"
        );
        assert_eq!(
            transcript(
                "No speech detected, skipping transcription.\n".into(),
                false
            )
            .unwrap(),
            ""
        );
        assert!(transcript("Loading audio file: x".into(), false).is_err());
        assert_eq!(
            transcript("Hello\n\nworld\n".into(), true).unwrap(),
            "Hello\n\nworld"
        );
    }
    #[tokio::test]
    async fn adapter_process_and_cleanup() {
        assert_eq!(
            execute(&["/usr/bin/printf".into(), "hello".into()], 2)
                .await
                .unwrap(),
            "hello"
        );
        assert!(execute(&["/usr/bin/false".into()], 2).await.is_err());
        assert!(
            execute(&["/usr/bin/sleep".into(), "5".into()], 0)
                .await
                .is_err()
        );
        let dir = AudioDir::new().unwrap();
        let path = dir.0.clone();
        drop(dir);
        assert!(!path.exists());
    }
}
