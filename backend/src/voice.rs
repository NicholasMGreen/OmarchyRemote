//! Read assistant progress and completed answers and synthesize them on the host. No terminal scraping.
use crate::{ApiError, App, apps, dictation, error};
use axum::{
    Json,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path as FsPath, PathBuf},
    sync::{LazyLock, Mutex},
    time::SystemTime,
};
use tokio::sync::Semaphore;

const MAX_TEXT: usize = 64 * 1024;
const MAX_AUDIO: u64 = 32 * 1024 * 1024;
static JOBS: Semaphore = Semaphore::const_new(1);
type ReadCache = HashMap<PathBuf, (u64, SystemTime, Value)>;
static READS: LazyLock<Mutex<ReadCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));
// Bounded, process-local audio cache: no permanent copies of conversations on disk.
static AUDIO: LazyLock<Mutex<HashMap<String, Vec<u8>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}
fn root(agent: &str) -> PathBuf {
    if agent == "codex" {
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".codex"))
            .join("sessions")
    } else {
        std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".claude"))
            .join("projects")
    }
}
fn contained(path: &FsPath, root: &FsPath) -> bool {
    path.canonicalize()
        .ok()
        .zip(root.canonicalize().ok())
        .is_some_and(|(p, r)| p.starts_with(r) && p.is_file())
}
fn find_session(root: &FsPath, id: &str) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(
        uuid::Uuid::parse_str(id).is_ok(),
        "Invalid conversation identity"
    );
    let suffix = format!("{id}.jsonl");
    let paths: Vec<_> = walkdir::WalkDir::new(root)
        .max_depth(5)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && e.file_name().to_string_lossy().ends_with(&suffix))
        .map(|e| e.into_path())
        .filter(|p| contained(p, root))
        .collect();
    anyhow::ensure!(
        paths.len() == 1,
        "No unique conversation log for this agent"
    );
    Ok(paths[0].clone())
}
fn resolve(agent: &str, info: &Value, reported: &Value) -> anyhow::Result<PathBuf> {
    let base = root(agent);
    if let Some(id) = reported["agent_session"]["value"].as_str() {
        return find_session(&base, id);
    }
    let processes = info["foreground_processes"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("No agent process"))?;
    let mut paths = Vec::new();
    for process in processes {
        if !process["name"].as_str().unwrap_or_default().contains(agent) {
            continue;
        }
        let Some(pid) = process["pid"].as_u64() else {
            continue;
        };
        if agent == "claude" {
            let record = base
                .parent()
                .unwrap()
                .join("sessions")
                .join(format!("{pid}.json"));
            if let Ok(bytes) = fs::read(record) {
                let value: Value = serde_json::from_slice(&bytes)?;
                // Check the process start time to reject a stale PID record after PID reuse.
                let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
                let start = stat
                    .rsplit_once(") ")
                    .and_then(|(_, s)| s.split_whitespace().nth(19));
                if value["procStart"].as_str() != start {
                    continue;
                }
                if let Some(id) = value["sessionId"].as_str() {
                    paths.push(find_session(&base, id)?);
                }
            }
        } else {
            for fd in fs::read_dir(format!("/proc/{pid}/fd"))?.flatten() {
                let Ok(path) = fs::read_link(fd.path()) else {
                    continue;
                };
                if path.extension().is_none_or(|x| x != "jsonl") || !contained(&path, &base) {
                    continue;
                }
                // Worker rollouts share the process; only the interactive CLI session belongs to this pane.
                let file = fs::File::open(&path)?;
                let mut head = String::new();
                use std::io::BufRead;
                std::io::BufReader::new(file.take(65536)).read_line(&mut head)?;
                if let Ok(meta) = serde_json::from_str::<Value>(&head)
                    && meta["type"] == "session_meta"
                    && meta["payload"]["source"] == "cli"
                {
                    paths.push(path);
                }
            }
        }
    }
    paths.sort();
    paths.dedup();
    anyhow::ensure!(
        paths.len() == 1,
        "Cannot identify this pane's conversation. Voice supports local Codex and Claude sessions with a unique session identity."
    );
    Ok(paths.remove(0))
}
fn blocks(value: &Value) -> String {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|v| v["type"] == "text" || v["type"] == "output_text")
                .filter_map(|v| v["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}
fn parse(agent: &str, log: &str) -> Value {
    let mut answer = Value::Null;
    let mut updates: Vec<Value> = Vec::new();
    let mut turn = Value::Null;
    let mut active = false;
    let mut candidate = String::new();
    let mut candidate_id = String::new();
    for (line_number, line) in log.lines().enumerate() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if agent == "codex" {
            let p = &v["payload"];
            if v["type"] == "response_item"
                && p["role"] == "assistant"
                && p["phase"] == "final_answer"
            {
                candidate = blocks(&p["content"]);
            }
            if active
                && !turn.is_null()
                && v["type"] == "response_item"
                && p["role"] == "assistant"
                && p["phase"] == "commentary"
            {
                let text = blocks(&p["content"]);
                if !text.trim().is_empty() {
                    let key = format!("update:{turn}:{}", updates.len());
                    updates.push(json!({"key":key,"text":text}));
                }
            }
            if v["type"] != "event_msg" {
                continue;
            }
            match p["type"].as_str().unwrap_or_default() {
                "task_started" => {
                    turn = p
                        .get("turn_id")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .or_else(|| v.get("timestamp").cloned())
                        .unwrap_or(json!(line_number));
                    updates.clear();
                    active = true;
                    candidate.clear();
                }
                "turn_aborted" => {
                    updates.clear();
                    turn = Value::Null;
                    active = false;
                    candidate.clear();
                }
                "task_complete" => {
                    active = false;
                    let text = p["last_agent_message"].as_str().unwrap_or(&candidate);
                    if !text.trim().is_empty() {
                        answer = json!({"key":p["turn_id"],"text":text});
                    }
                    candidate.clear();
                }
                _ => {}
            }
        } else if v["isSidechain"] != true {
            let m = &v["message"];
            let local = m["content"].as_str().is_some_and(|s| {
                [
                    "<local-command-caveat>",
                    "<local-command-stdout>",
                    "<command-name>",
                ]
                .iter()
                .any(|prefix| s.trim_start().starts_with(prefix))
            });
            if v["isMeta"] == true || local {
                continue;
            }
            if v["type"] == "user" {
                // Tool results are user-role records too; they continue the same turn.
                let tool_result = m["content"]
                    .as_array()
                    .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result"));
                if !tool_result {
                    turn = v.get("uuid").cloned().unwrap_or(json!(line_number));
                    updates.clear();
                }
                active = true;
                candidate.clear();
                candidate_id.clear();
            }
            if v["type"] != "assistant" {
                continue;
            }
            active = true;
            // These are persisted assistant text blocks, not streaming deltas or thinking.
            if !turn.is_null() && m["stop_reason"] == "tool_use" {
                let text = blocks(&m["content"]);
                let key = format!(
                    "update:{turn}:{}",
                    v.get("uuid").cloned().unwrap_or(json!(line_number))
                );
                if !text.trim().is_empty() && !updates.iter().any(|u| u["key"] == key) {
                    updates.push(json!({"key":key,"text":text}));
                }
            }
            if m["stop_reason"] != "end_turn" {
                candidate.clear();
                candidate_id.clear();
                continue;
            }
            let text = blocks(&m["content"]);
            if text.is_empty() {
                continue;
            }
            let id = m["id"].as_str().unwrap_or_default();
            if candidate_id != id {
                candidate.clear();
                candidate_id = id.to_owned();
            }
            if !candidate.is_empty() {
                candidate.push_str("\n\n");
            }
            candidate.push_str(&text);
            answer = json!({"key":id,"text":candidate});
            active = false;
        }
    }
    json!({"answer":answer,"updates":updates,"working":active})
}
fn read_answer(agent: &str, path: &FsPath) -> anyhow::Result<Value> {
    let meta = fs::metadata(path)?;
    let modified = meta.modified()?;
    if let Some((len, time, value)) = READS.lock().unwrap().get(path)
        && *len == meta.len()
        && *time == modified
    {
        return Ok(value.clone());
    }
    let mut file = fs::File::open(path)?;
    let offset = meta.len().saturating_sub(16 * 1024 * 1024);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    file.take(16 * 1024 * 1024).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let text = if offset > 0 {
        text.split_once('\n').map(|(_, t)| t).unwrap_or_default()
    } else {
        &text
    };
    let mut value = parse(agent, text);
    let session = path.file_stem().unwrap_or_default().to_string_lossy();
    value["session"] = json!(session);
    if !value["answer"].is_null() {
        identify(&mut value["answer"], &session);
    }
    if let Some(updates) = value["updates"].as_array_mut() {
        for update in updates {
            identify(update, &session);
        }
    }
    let mut cache = READS.lock().unwrap();
    if cache.len() >= 32 {
        cache.clear();
    }
    cache.insert(path.to_owned(), (meta.len(), modified, value.clone()));
    Ok(value)
}
fn identify(message: &mut Value, session: &str) {
    let key = format!("{}:{}:{}", session, message["key"], message["text"]);
    message["id"] = json!(format!("{:x}", Sha256::digest(key.as_bytes())));
}
fn speech_message<'a>(value: &'a Value, id: &str) -> Option<&'a Value> {
    std::iter::once(&value["answer"])
        .chain(value["updates"].as_array().into_iter().flatten())
        .find(|message| message["id"].as_str() == Some(id))
}
async fn latest(app: &App, pane: &str) -> anyhow::Result<Value> {
    let snapshot = app.herdr.call("session.snapshot", json!({})).await?;
    let agent = snapshot["snapshot"]["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|p| p["pane_id"] == pane))
        .ok_or_else(|| anyhow::anyhow!("No supported agent in this pane"))?
        .clone();
    let name = agent["agent"].as_str().unwrap_or_default().to_owned();
    anyhow::ensure!(
        name == "codex" || name == "claude",
        "Voice currently supports Codex and Claude"
    );
    let info = app
        .herdr
        .call("pane.process_info", json!({"pane_id":pane}))
        .await?;
    tokio::task::spawn_blocking(move || {
        let path = resolve(&name, &info["process_info"], &agent)?;
        let mut value = read_answer(&name, &path)?;
        value["can_send"] = json!(matches!(
            agent["agent_status"].as_str(),
            Some("idle" | "done")
        ));
        // A live working state suppresses premature playback even if a transcript block looks final.
        if agent["agent_status"] == "working" {
            value["working"] = json!(true);
        }
        Ok(value)
    })
    .await?
}
pub async fn response(
    State(app): State<App>,
    Path(pane): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(latest(&app, &pane).await.map_err(error)?))
}
fn adapter() -> anyhow::Result<Vec<String>> {
    let args: Vec<String> = if let Ok(value) = std::env::var("OMARCHY_SPEECH_COMMAND") {
        serde_json::from_str(&value)?
    } else {
        let model = std::env::var("OMARCHY_SPEECH_MODEL").unwrap_or_else(|_| {
            home()
                .join(".local/share/omarchy-remote/voices/en_US-lessac-medium.onnx")
                .to_string_lossy()
                .into()
        });
        vec![
            "piper".into(),
            "--model".into(),
            model,
            "--input-file".into(),
            "{text}".into(),
            "--output-file".into(),
            "{audio}".into(),
        ]
    };
    anyhow::ensure!(
        !args.is_empty()
            && args.iter().skip(1).any(|x| x == "{text}")
            && args.iter().skip(1).any(|x| x == "{audio}"),
        "Speech command must contain {{text}} and {{audio}} arguments"
    );
    Ok(args)
}
pub async fn status() -> Json<Value> {
    let ready = adapter().is_ok_and(|a| {
        apps::resolve_program(&a[0]).is_ok()
            && (std::env::var_os("OMARCHY_SPEECH_COMMAND").is_some()
                || FsPath::new(&a[2]).is_file())
    });
    Json(
        json!({"available":ready,"provider":if std::env::var_os("OMARCHY_SPEECH_COMMAND").is_some() {"Custom command"} else {"Piper"},"message":if ready {"Ready"} else {"Install Piper and a voice model, or configure OMARCHY_SPEECH_COMMAND"}}),
    )
}
fn spoken(text: &str) -> String {
    let mut fence = None;
    let mut lines = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = &trimmed[..3];
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
                lines.push("Code block omitted.");
            }
            continue;
        }
        if fence.is_none() {
            lines.push(line.trim_start_matches('#').trim());
        }
    }
    let text = lines.join("\n");
    let links = regex::Regex::new(r"\[([^\]]+)\]\([^\)]+\)").unwrap();
    links.replace_all(&text, "$1").replace(['*', '`'], "")
}
#[derive(Deserialize)]
pub struct SpeechRequest {
    response_id: String,
}
pub async fn audio(
    State(app): State<App>,
    Path(pane): Path<String>,
    Json(request): Json<SpeechRequest>,
) -> Result<Response, ApiError> {
    let value = latest(&app, &pane).await.map_err(error)?;
    let Some(answer) = speech_message(&value, &request.response_id) else {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error":"The response changed; read the latest answer"})),
        ));
    };
    let mut args = adapter().map_err(error)?;
    let cache_key = format!("{}:{:?}", request.response_id, args);
    if let Some(data) = AUDIO.lock().unwrap().get(&cache_key).cloned() {
        return Ok(wav(data));
    }
    let _permit = JOBS.try_acquire().map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"Speech is busy; try Replay shortly"})),
        )
    })?;
    let text = spoken(answer["text"].as_str().unwrap_or_default());
    if text.is_empty() || text.len() > MAX_TEXT {
        return Err(error(
            "Response is empty or exceeds the 64 KiB speech limit",
        ));
    }
    let dir = dictation::AudioDir::new().map_err(error)?;
    let input = dir.0.join("response.txt");
    let output = dir.0.join("response.wav");
    tokio::fs::write(&input, text).await.map_err(error)?;
    for arg in args.iter_mut().skip(1) {
        if arg == "{text}" {
            *arg = input.to_string_lossy().into();
        } else if arg == "{audio}" {
            *arg = output.to_string_lossy().into();
        }
    }
    dictation::execute(&args, 180)
        .await
        .map_err(|_| error("Speech generation failed or timed out; check the host provider"))?;
    let meta = tokio::fs::symlink_metadata(&output).await.map_err(error)?;
    if !meta.is_file() || meta.len() > MAX_AUDIO {
        return Err(error(
            "Speech audio exceeds 32 MiB or is not a regular file",
        ));
    }
    let data = tokio::fs::read(output).await.map_err(error)?;
    if !data.starts_with(b"RIFF") || data.get(8..12) != Some(b"WAVE") {
        return Err(error("Speech command must produce a WAV file"));
    }
    let mut cache = AUDIO.lock().unwrap();
    if cache.values().map(Vec::len).sum::<usize>() + data.len() > 64 * 1024 * 1024 {
        cache.clear();
    }
    cache.insert(cache_key, data.clone());
    Ok(wav(data))
}
fn wav(data: Vec<u8>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "audio/wav"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        data,
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct VoiceInput {
    session: String,
    text: String,
}
pub async fn send(
    State(app): State<App>,
    Path(pane): Path<String>,
    Json(input): Json<VoiceInput>,
) -> Result<Json<Value>, ApiError> {
    if input.text.trim().is_empty() || input.text.len() > 16384 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"Voice message is empty or too long"})),
        ));
    }
    let latest = latest(&app, &pane).await.map_err(error)?;
    if latest["session"] != input.session
        || latest["working"] != false
        || latest["can_send"] != true
    {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error":"Agent is busy or conversation changed; draft kept"})),
        ));
    }
    Ok(Json(
        app.herdr
            .input(&pane, &input.text, &["Enter".into()], false)
            .await
            .map_err(error)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_keeps_progress_separate_from_completed_answers() {
        let log = [
            json!({"type":"event_msg","payload":{"type":"task_started"}}),
            json!({"type":"response_item","payload":{"role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Working"}]}}),
            json!({"type":"response_item","payload":{"role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Complete answer"}]}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        assert!(parse("codex", &log)["answer"].is_null());
        assert_eq!(parse("codex", &log)["updates"][0]["text"], "Working");
        let done = format!(
            "{log}\n{}",
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"1"}})
        );
        assert_eq!(parse("codex", &done)["answer"]["text"], "Complete answer");
        let working = format!(
            "{done}\n{}",
            json!({"type":"event_msg","payload":{"type":"task_started"}})
        );
        assert_eq!(parse("codex", &working)["working"], true);
        assert_eq!(parse("codex", &working)["answer"]["key"], "1");
        let abort = format!(
            "{working}\n{}",
            json!({"type":"event_msg","payload":{"type":"turn_aborted"}})
        );
        assert_eq!(parse("codex", &abort)["working"], false);
    }
    #[test]
    fn claude_skips_tools_thoughts_and_sidechains() {
        let log = [
            json!({"type":"assistant","message":{"id":"one","stop_reason":"tool_use","content":[{"type":"text","text":"Running a tool"}]}}),
            json!({"type":"assistant","message":{"id":"two","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"Private"},{"type":"text","text":"First paragraph"}]}}),
            json!({"type":"assistant","message":{"id":"two","stop_reason":"end_turn","content":[{"type":"text","text":"Second paragraph"}]}}),
            json!({"type":"user","message":{"content":"<command-name>/exit</command-name>"}}),
            json!({"type":"user","isMeta":true,"message":{"content":"local metadata"}}),
            json!({"type":"assistant","isSidechain":true,"message":{"id":"worker","stop_reason":"end_turn","content":[{"type":"text","text":"Worker response"}]}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        assert_eq!(
            parse("claude", &log)["answer"]["text"],
            "First paragraph\n\nSecond paragraph"
        );
        assert_eq!(parse("claude", &log)["working"], false);
    }
    fn log(rows: &[Value]) -> String {
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }
    #[test]
    fn codex_progress_is_ordered_and_stops_at_turn_boundaries() {
        let rows = vec![
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"one"}}),
            json!({"type":"response_item","payload":{"type":"function_call","arguments":"do not speak tools"}}),
            json!({"type":"response_item","payload":{"role":"assistant","phase":"analysis","content":[{"type":"output_text","text":"private"}]}}),
            json!({"type":"response_item","payload":{"role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"I will check."}]}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"I will check."}}),
            json!({"type":"response_item","payload":{"role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Found the problem."}]}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"one","last_agent_message":"Fixed."}}),
        ];
        let result = parse("codex", &log(&rows));
        assert_eq!(result["updates"].as_array().unwrap().len(), 2);
        assert_eq!(result["updates"][0]["text"], "I will check.");
        assert_eq!(result["updates"][1]["text"], "Found the problem.");
        assert_eq!(result["answer"]["text"], "Fixed.");
        let mut next = rows;
        next.push(json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"two"}}));
        assert_eq!(parse("codex", &log(&next))["updates"], json!([]));
        next.push(json!({"type":"response_item","payload":{"role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Next task."}]}}));
        next.push(json!({"type":"event_msg","payload":{"type":"turn_aborted"}}));
        assert_eq!(parse("codex", &log(&next))["updates"], json!([]));
    }
    #[test]
    fn claude_progress_excludes_tools_reasoning_and_workers() {
        let rows = vec![
            json!({"type":"user","uuid":"turn-one","message":{"content":"Request"}}),
            json!({"type":"assistant","uuid":"thinking","message":{"stop_reason":"tool_use","content":[{"type":"thinking","thinking":"private"}]}}),
            json!({"type":"assistant","uuid":"first","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"Checking."},{"type":"tool_use","input":{"secret":"tool"}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"private result"}]}}),
            json!({"type":"assistant","uuid":"worker","isSidechain":true,"message":{"stop_reason":"tool_use","content":[{"type":"text","text":"worker"}]}}),
            json!({"type":"assistant","uuid":"second","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"Testing the fix."}]}}),
            json!({"type":"assistant","uuid":"incomplete","message":{"stop_reason":null,"content":[{"type":"text","text":"unfinished"}]}}),
            json!({"type":"assistant","message":{"id":"final","stop_reason":"end_turn","content":[{"type":"text","text":"Done."}]}}),
        ];
        let result = parse("claude", &log(&rows));
        assert_eq!(result["updates"].as_array().unwrap().len(), 2);
        assert_eq!(result["updates"][0]["text"], "Checking.");
        assert_eq!(result["updates"][1]["text"], "Testing the fix.");
        assert_eq!(result["answer"]["text"], "Done.");
        let mut next = rows;
        next.push(json!({"type":"user","uuid":"turn-two","message":{"content":"Next"}}));
        assert_eq!(parse("claude", &log(&next))["updates"], json!([]));
    }
    #[test]
    fn speech_ids_accept_only_current_progress_or_completed_answer() {
        let mut value = json!({"answer":{"key":"final","text":"Done"},"updates":[{"key":"update:one","text":"Checking"}]});
        identify(&mut value["answer"], "session");
        identify(&mut value["updates"][0], "session");
        let id = value["updates"][0]["id"].as_str().unwrap().to_owned();
        assert_eq!(speech_message(&value, &id).unwrap()["text"], "Checking");
        assert!(speech_message(&value, "arbitrary text").is_none());
        let mut other = value["updates"][0].clone();
        identify(&mut other, "other-session");
        assert_ne!(other["id"], id);
        value["updates"] = json!([]);
        assert!(speech_message(&value, &id).is_none());
    }
    #[test]
    fn spoken_prose_keeps_paragraphs_and_omits_code() {
        assert_eq!(
            spoken(
                "## Result\n\n**Done** [details](https://example.test)\n```rust\nsecret code\n```\nNext paragraph."
            ),
            "Result\n\nDone details\nCode block omitted.\nNext paragraph."
        );
    }
    #[test]
    fn resolver_rejects_paths_and_ambiguous_logs() {
        let dir = dictation::AudioDir::new().unwrap();
        assert!(find_session(&dir.0, "../../outside").is_err());
        let id = uuid::Uuid::new_v4().to_string();
        assert!(find_session(&dir.0, &id).is_err());
        fs::write(dir.0.join(format!("{id}.jsonl")), "").unwrap();
        assert!(find_session(&dir.0, &id).is_ok());
        fs::write(dir.0.join(format!("rollout-{id}.jsonl")), "").unwrap();
        assert!(find_session(&dir.0, &id).is_err());
    }
}
