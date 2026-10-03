//! Chat: conversations with a local Claude Code agent, outside any project. Each conversation is
//! a Markdown file in `~/Chats/conversations`, the app's own record (readable, and easy to back up
//! with git), and the agent runs in `~/Chats`. Claude's session log is only used to resume.
use crate::{ApiError, App, apps, error};
use axum::{
    Json,
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::Response,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::broadcast,
};

const MAX_TEXT: usize = 64 * 1024;
/// A conversation's agent process exits after this long without a message.
const IDLE: Duration = Duration::from_secs(15 * 60);
const MARK: &str = "<!-- omarchy-chat:";

#[derive(Clone, Debug, Default, PartialEq)]
struct Entry {
    /// `user`, `assistant`, or `tool`.
    role: String,
    time: String,
    /// The tool's name; empty for messages.
    name: String,
    text: String,
}
impl Entry {
    fn new(role: &str, name: &str, text: &str) -> Self {
        Self {
            role: role.into(),
            time: now(),
            name: name.into(),
            text: text.into(),
        }
    }
    fn json(&self) -> Value {
        json!({"role":self.role,"time":self.time,"name":self.name,"text":self.text})
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Conversation {
    id: String,
    agent: String,
    /// The agent's own session id, for resuming.
    session: String,
    title: String,
    created: String,
    updated: String,
    entries: Vec<Entry>,
}
impl Conversation {
    fn preview(&self) -> String {
        let text = self
            .entries
            .iter()
            .rev()
            .find(|e| e.role != "tool")
            .map(|e| e.text.as_str())
            .unwrap_or_default();
        clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), 160)
    }
    fn summary(&self) -> Value {
        json!({"id":self.id,"agent":self.agent,"title":self.title,"created":self.created,"updated":self.updated,"preview":self.preview()})
    }
    fn json(&self) -> Value {
        let mut value = self.summary();
        value["entries"] = self.entries.iter().map(Entry::json).collect();
        value
    }
    fn label(&self, role: &str) -> &'static str {
        match (role, self.agent.as_str()) {
            ("user", _) => "**You**",
            (_, "codex") => "**Codex**",
            _ => "**Claude**",
        }
    }
    /// Front matter (JSON strings are valid YAML) and one marked section per entry. The markers
    /// are HTML comments, so a rendered file reads as a plain conversation.
    fn to_markdown(&self) -> String {
        let mut out = String::from("---\n");
        for (key, value) in [
            ("id", &self.id),
            ("agent", &self.agent),
            ("session", &self.session),
            ("title", &self.title),
            ("created", &self.created),
            ("updated", &self.updated),
            ("preview", &self.preview()),
        ] {
            out.push_str(&format!("{key}: {}\n", json!(value)));
        }
        out.push_str("---\n");
        for entry in &self.entries {
            out.push('\n');
            if entry.role == "tool" {
                let name: String = entry
                    .name
                    .chars()
                    .map(|c| if c.is_whitespace() { '_' } else { c })
                    .collect();
                let summary = entry.text.split_whitespace().collect::<Vec<_>>().join(" ");
                out.push_str(&format!(
                    "{MARK}tool {} {name} -->\n> {summary}\n",
                    entry.time
                ));
                continue;
            }
            out.push_str(&format!(
                "{MARK}{} {} -->\n{}\n\n",
                entry.role,
                entry.time,
                self.label(&entry.role)
            ));
            for line in entry.text.lines() {
                // A line that looks like a marker gains one leading space; reading removes it.
                if line.trim_start().starts_with(MARK) {
                    out.push(' ');
                }
                out.push_str(line);
                out.push('\n');
            }
        }
        out
    }
    fn parse(text: &str) -> Option<Self> {
        let (fields, body) = front_matter(text)?;
        let field = |key: &str| fields.get(key).cloned().unwrap_or_default();
        let mut conversation = Self {
            id: field("id"),
            agent: field("agent"),
            session: field("session"),
            title: field("title"),
            created: field("created"),
            updated: field("updated"),
            entries: Vec::new(),
        };
        let mut current: Option<(Entry, Vec<&str>)> = None;
        let finish = |current: Option<(Entry, Vec<&str>)>, entries: &mut Vec<Entry>| {
            let Some((mut entry, mut lines)) = current else {
                return;
            };
            if entry.role == "tool" {
                entry.text = lines
                    .first()
                    .map(|l| l.strip_prefix("> ").unwrap_or(l).to_owned())
                    .unwrap_or_default();
            } else {
                if lines
                    .first()
                    .is_some_and(|l| ["**You**", "**Claude**", "**Codex**"].contains(l))
                {
                    lines.remove(0);
                    if lines.first() == Some(&"") {
                        lines.remove(0);
                    }
                }
                while lines.last() == Some(&"") {
                    lines.pop();
                }
                entry.text = lines
                    .iter()
                    .map(|l| {
                        if l.starts_with(' ') && l.trim_start().starts_with(MARK) {
                            &l[1..]
                        } else {
                            l
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
            }
            entries.push(entry);
        };
        for line in body.lines() {
            if let Some(marker) = line.strip_prefix(MARK).and_then(|m| m.strip_suffix(" -->")) {
                finish(current.take(), &mut conversation.entries);
                let mut parts = marker.splitn(3, ' ');
                let role = parts.next().unwrap_or_default();
                let time = parts.next().unwrap_or_default();
                let name = parts.next().unwrap_or_default();
                if ["user", "assistant", "tool"].contains(&role) {
                    current = Some((
                        Entry {
                            role: role.into(),
                            time: time.into(),
                            name: name.into(),
                            text: String::new(),
                        },
                        Vec::new(),
                    ));
                }
                continue;
            }
            if let Some((_, lines)) = current.as_mut() {
                lines.push(line);
            }
        }
        finish(current, &mut conversation.entries);
        uuid::Uuid::parse_str(&conversation.id).ok()?;
        Some(conversation)
    }
}
fn front_matter(text: &str) -> Option<(HashMap<String, String>, &str)> {
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---\n")?;
    let mut fields = HashMap::new();
    for line in rest[..end].lines() {
        let (key, value) = line.split_once(": ")?;
        fields.insert(key.to_owned(), serde_json::from_str::<String>(value).ok()?);
    }
    Some((fields, &rest[end + 5..]))
}
fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut clipped: String = text.chars().take(limit - 1).collect();
    clipped.push('…');
    clipped
}
fn title(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("New chat");
    clip(&line.split_whitespace().collect::<Vec<_>>().join(" "), 60)
}
fn slug(title: &str) -> String {
    let words: Vec<String> = title
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(6)
        .map(str::to_ascii_lowercase)
        .collect();
    let slug = clip(&words.join("-"), 40).trim_end_matches('…').to_owned();
    if slug.is_empty() { "chat".into() } else { slug }
}
fn now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    timestamp(seconds)
}
/// RFC 3339 UTC, from days since 1970 (Howard Hinnant's civil-from-days).
fn timestamp(seconds: i64) -> String {
    let (days, rest) = (seconds.div_euclid(86400), seconds.rem_euclid(86400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

fn tilde(path: &FsPath) -> String {
    match apps::home()
        .ok()
        .and_then(|home| path.strip_prefix(home).ok().map(PathBuf::from))
    {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}
/// `~/Chats`, or `OMARCHY_CHAT_DIR` inside the home directory.
fn root() -> anyhow::Result<PathBuf> {
    let home = apps::home()?;
    let root = match std::env::var_os("OMARCHY_CHAT_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => home.join("Chats"),
    };
    anyhow::ensure!(
        root.is_absolute() && root.starts_with(&home) && root != home,
        "OMARCHY_CHAT_DIR must be a folder inside the home directory"
    );
    Ok(root)
}
fn folder(root: &FsPath) -> anyhow::Result<PathBuf> {
    let folder = root.join("conversations");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&folder)?;
    Ok(folder)
}
fn find(folder: &FsPath, id: &str) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(uuid::Uuid::parse_str(id).is_ok(), "Invalid chat");
    let suffix = format!("-{}.md", &id[..8]);
    for entry in fs::read_dir(folder)?.flatten() {
        let path = entry.path();
        if path.to_string_lossy().ends_with(&suffix)
            && head(&path)
                .is_some_and(|(fields, _)| fields.get("id").map(String::as_str) == Some(id))
        {
            return Ok(path);
        }
    }
    anyhow::bail!("Chat not found")
}
/// The front matter of a conversation file, read without the rest of it.
fn head(path: &FsPath) -> Option<(HashMap<String, String>, ())> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(16 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    let text = String::from_utf8_lossy(&bytes);
    front_matter(&text).map(|(fields, _)| (fields, ()))
}
fn load(path: &FsPath) -> anyhow::Result<Conversation> {
    Conversation::parse(&fs::read_to_string(path)?)
        .ok_or_else(|| anyhow::anyhow!("Unreadable chat file {}", path.display()))
}
/// Writes the whole file to a private temporary file, then renames it over the old one.
fn save(conversation: &Conversation, path: &FsPath) -> anyhow::Result<()> {
    let temporary = path.with_extension("md.tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(conversation.to_markdown().as_bytes())?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}
fn list(folder: &FsPath) -> Vec<Value> {
    let mut chats: Vec<Value> = fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
        .filter_map(|e| head(&e.path()))
        .filter(|(fields, _)| {
            fields
                .get("id")
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        })
        .map(|(fields, _)| json!(fields))
        .collect();
    chats.sort_by(|a, b| b["updated"].as_str().cmp(&a["updated"].as_str()));
    chats
}

/// The state of a conversation whose agent is running.
struct Live {
    conversation: Conversation,
    path: PathBuf,
    busy: bool,
    /// Text of the assistant message being streamed, and how many deltas it has had.
    partial: String,
    seq: u64,
    /// The API message the last assistant entry came from, so its later blocks join it.
    message: String,
    used: Instant,
    /// Stop was requested, so the agent's exit ends the turn without an error.
    stopping: bool,
}
impl Live {
    /// Applies one line of Claude's stream-json output; returns the events to broadcast.
    fn apply(&mut self, line: &Value) -> Vec<Value> {
        let id = self.conversation.id.clone();
        let mut events = Vec::new();
        match line["type"].as_str().unwrap_or_default() {
            "stream_event" => {
                let event = &line["event"];
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta"
                {
                    let text = event["delta"]["text"].as_str().unwrap_or_default();
                    self.partial.push_str(text);
                    self.seq += 1;
                    events.push(json!({"type":"delta","id":id,"seq":self.seq,"text":text}));
                }
            }
            "assistant" if line["parent_tool_use_id"].is_null() => {
                let message = line["message"]["id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                for block in line["message"]["content"].as_array().into_iter().flatten() {
                    let entry = match block["type"].as_str() {
                        Some("text") => {
                            let text = block["text"].as_str().unwrap_or_default();
                            if text.trim().is_empty() {
                                continue;
                            }
                            self.partial.clear();
                            let index = self.conversation.entries.len().saturating_sub(1);
                            let last = self.conversation.entries.last_mut();
                            if let Some(last) = last
                                && last.role == "assistant"
                                && !message.is_empty()
                                && message == self.message
                            {
                                last.text.push_str("\n\n");
                                last.text.push_str(text);
                                events.push(json!({"type":"entry","id":id,"index":index,"entry":last.json()}));
                                continue;
                            }
                            Entry::new("assistant", "", text)
                        }
                        Some("tool_use") => Entry::new(
                            "tool",
                            block["name"].as_str().unwrap_or("tool"),
                            &tool_summary(&block["input"]),
                        ),
                        _ => continue,
                    };
                    self.message = message.clone();
                    events.push(json!({"type":"entry","id":id,"index":self.conversation.entries.len(),"entry":entry.json()}));
                    self.conversation.entries.push(entry);
                }
            }
            "result" => {
                self.busy = false;
                self.partial.clear();
                let failed = line["is_error"] == true || line["subtype"] != "success";
                let message = line["result"]
                    .as_str()
                    .or_else(|| line["errors"][0].as_str())
                    .unwrap_or("The agent stopped with an error");
                events.push(json!({"type":"done","id":id,"error":if failed {json!(message)} else {Value::Null}}));
            }
            _ => {}
        }
        if events.iter().any(|e| e["type"] != "delta") {
            self.conversation.updated = now();
        }
        events
    }
}
fn tool_summary(input: &Value) -> String {
    let text = [
        "description",
        "command",
        "query",
        "url",
        "file_path",
        "pattern",
        "prompt",
        "path",
    ]
    .iter()
    .find_map(|key| input[*key].as_str())
    .unwrap_or_default();
    clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), 200)
}

struct Running {
    stdin: tokio::sync::Mutex<ChildStdin>,
    child: tokio::sync::Mutex<Child>,
    live: Mutex<Live>,
}

#[derive(Clone)]
pub struct Chats {
    running: Arc<Mutex<HashMap<String, Arc<Running>>>>,
    events: broadcast::Sender<Value>,
    /// Numbers every event. A chat read reports the number its state includes, so a client
    /// applies only the events after it.
    counter: Arc<AtomicU64>,
}
pub fn start() -> Chats {
    let chats = Chats {
        running: Arc::new(Mutex::new(HashMap::new())),
        events: broadcast::channel(1024).0,
        counter: Arc::new(AtomicU64::new(0)),
    };
    let reaper = chats.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let idle: Vec<Arc<Running>> = reaper
                .running
                .lock()
                .unwrap()
                .values()
                .filter(|r| {
                    let live = r.live.lock().unwrap();
                    !live.busy && live.used.elapsed() > IDLE
                })
                .cloned()
                .collect();
            for running in idle {
                let _ = running.child.lock().await.start_kill();
            }
        }
    });
    chats
}
impl Chats {
    /// Numbers events while the conversation they change is still locked.
    fn stamp(&self, events: &mut [Value]) {
        for event in events {
            event["n"] = json!(self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        }
    }
    fn emit(&self, events: Vec<Value>) {
        for event in events {
            let _ = self.events.send(event);
        }
    }
    fn get(&self, id: &str) -> Option<Arc<Running>> {
        self.running.lock().unwrap().get(id).cloned()
    }
    /// Starts the agent for a conversation: a new session, or a resumed one.
    fn spawn(&self, live: Live, resume: bool, root: &FsPath) -> anyhow::Result<Arc<Running>> {
        let mut args: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            // Nobody answers approval prompts yet: anything that would ask is denied.
            "--permission-prompts",
            "none",
        ]
        .map(String::from)
        .into();
        if let Ok(extra) = std::env::var("OMARCHY_CHAT_CLAUDE_ARGS") {
            args.extend(serde_json::from_str::<Vec<String>>(&extra)?);
        }
        args.push(if resume { "--resume" } else { "--session-id" }.into());
        args.push(live.conversation.session.clone());
        let mut child = Command::new(apps::resolve_program("claude")?)
            .args(&args)
            .current_dir(root)
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .env_remove("CLAUDE_CODE_SESSION_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let id = live.conversation.id.clone();
        let running = Arc::new(Running {
            stdin: tokio::sync::Mutex::new(child.stdin.take().unwrap()),
            child: tokio::sync::Mutex::new(child),
            live: Mutex::new(live),
        });
        self.running
            .lock()
            .unwrap()
            .insert(id.clone(), running.clone());
        let chats = self.clone();
        let reader = running.clone();
        tokio::spawn(async move {
            let errors = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                let mut last = String::new();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        last = clip(&line, 300);
                    }
                }
                last
            });
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let events = {
                    let mut live = reader.live.lock().unwrap();
                    let mut events = live.apply(&value);
                    chats.stamp(&mut events);
                    if events.iter().any(|e| e["type"] != "delta")
                        && let Err(e) = save(&live.conversation, &live.path)
                    {
                        eprintln!("chat: could not save {}: {e}", live.path.display());
                    }
                    events
                };
                chats.emit(events);
            }
            let _ = reader.child.lock().await.wait().await;
            let last = errors.await.unwrap_or_default();
            chats.finish(&id, &reader, &last);
        });
        Ok(running)
    }
    /// The agent exited: keep any streamed text, and end a turn it left unfinished.
    fn finish(&self, id: &str, running: &Arc<Running>, stderr: &str) {
        {
            let mut map = self.running.lock().unwrap();
            if map.get(id).is_some_and(|r| Arc::ptr_eq(r, running)) {
                map.remove(id);
            }
        }
        let mut live = running.live.lock().unwrap();
        let mut events = Vec::new();
        if !live.partial.trim().is_empty() {
            let entry = Entry::new("assistant", "", &live.partial);
            events.push(json!({"type":"entry","id":id,"index":live.conversation.entries.len(),"entry":entry.json()}));
            live.conversation.entries.push(entry);
            live.partial.clear();
            let _ = save(&live.conversation, &live.path);
        }
        if live.busy {
            live.busy = false;
            let message = if stderr.is_empty() {
                "The agent stopped"
            } else {
                stderr
            };
            let error = if live.stopping {
                Value::Null
            } else {
                json!(message)
            };
            events.push(json!({"type":"done","id":id,"error":error}));
        }
        self.stamp(&mut events);
        drop(live);
        self.emit(events);
    }
}

pub async fn status(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    let root = root().map_err(error)?;
    let folder = folder(&root).map_err(error)?;
    let running = app.chats.running.lock().unwrap();
    let chats: Vec<Value> = list(&folder)
        .into_iter()
        .map(|mut chat| {
            let id = chat["id"].as_str().unwrap_or_default();
            chat["busy"] = json!(running.get(id).is_some_and(|r| r.live.lock().unwrap().busy));
            chat
        })
        .collect();
    let available = apps::resolve_program("claude").is_ok();
    Ok(Json(json!({
        "folder": tilde(&root),
        "available": available,
        "agent": "claude",
        "chats": chats,
    })))
}

pub async fn read(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    if let Some(running) = app.chats.get(&id) {
        let live = running.live.lock().unwrap();
        let mut value = live.conversation.json();
        value["busy"] = json!(live.busy);
        value["partial"] = json!(live.partial);
        value["seq"] = json!(live.seq);
        value["n"] = json!(app.chats.counter.load(Ordering::SeqCst));
        return Ok(Json(value));
    }
    let folder = folder(&root().map_err(error)?).map_err(error)?;
    let path = find(&folder, &id)
        .map_err(|e| (StatusCode::NOT_FOUND, Json(json!({"error":e.to_string()}))))?;
    let mut value = load(&path).map_err(error)?.json();
    value["busy"] = json!(false);
    value["partial"] = json!("");
    value["seq"] = json!(0);
    value["n"] = json!(app.chats.counter.load(Ordering::SeqCst));
    Ok(Json(value))
}

#[derive(Deserialize)]
pub struct Send {
    #[serde(default)]
    id: Option<String>,
    text: String,
}
pub async fn send(
    State(app): State<App>,
    Json(request): Json<Send>,
) -> Result<Json<Value>, ApiError> {
    let text = request.text.trim().to_owned();
    if text.is_empty() || text.len() > MAX_TEXT {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"The message is empty or longer than 64 KiB"})),
        ));
    }
    let chats = app.chats.clone();
    let root = root().map_err(error)?;
    let folder = folder(&root).map_err(error)?;
    let running = match request.id.as_deref().and_then(|id| chats.get(id)) {
        Some(running) => running,
        None => {
            let (conversation, path, resume) = match &request.id {
                Some(id) => {
                    let path = find(&folder, id).map_err(|e| {
                        (StatusCode::NOT_FOUND, Json(json!({"error":e.to_string()})))
                    })?;
                    (load(&path).map_err(error)?, path, true)
                }
                None => {
                    let id = uuid::Uuid::new_v4().to_string();
                    let title = title(&text);
                    let created = now();
                    let path = folder.join(format!(
                        "{}-{}-{}.md",
                        &created[..10],
                        slug(&title),
                        &id[..8]
                    ));
                    let conversation = Conversation {
                        session: id.clone(),
                        id,
                        agent: "claude".into(),
                        title,
                        updated: created.clone(),
                        created,
                        entries: Vec::new(),
                    };
                    (conversation, path, false)
                }
            };
            let live = Live {
                conversation,
                path,
                busy: false,
                partial: String::new(),
                seq: 0,
                message: String::new(),
                used: Instant::now(),
                stopping: false,
            };
            chats.spawn(live, resume, &root).map_err(error)?
        }
    };
    let (id, events) = {
        let mut live = running.live.lock().unwrap();
        let entry = Entry::new("user", "", &text);
        let id = live.conversation.id.clone();
        let mut events = vec![
            json!({"type":"entry","id":id,"index":live.conversation.entries.len(),"entry":entry.json()}),
            json!({"type":"busy","id":id}),
        ];
        chats.stamp(&mut events);
        live.conversation.entries.push(entry);
        live.conversation.updated = now();
        live.busy = true;
        live.used = Instant::now();
        save(&live.conversation, &live.path).map_err(error)?;
        (id, events)
    };
    chats.emit(events);
    let line = json!({"type":"user","message":{"role":"user","content":text}}).to_string() + "\n";
    let mut stdin = running.stdin.lock().await;
    if let Err(e) = stdin.write_all(line.as_bytes()).await {
        drop(stdin);
        let _ = running.child.lock().await.start_kill();
        return Err(error(format!("The agent is not running: {e}")));
    }
    Ok(Json(json!({"id":id})))
}

/// Stops the agent mid-reply. Its session keeps everything up to the last complete message, and
/// the streamed text so far is kept in the conversation.
pub async fn stop(State(app): State<App>, Path(id): Path<String>) -> Json<Value> {
    if let Some(running) = app.chats.get(&id) {
        running.live.lock().unwrap().stopping = true;
        let _ = running.child.lock().await.start_kill();
    }
    Json(json!({"stopped":true}))
}

pub async fn upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(4096)
        .on_upgrade(move |socket| events(socket, app.chats))
}
async fn events(mut socket: WebSocket, chats: Chats) {
    let mut receiver = chats.events.subscribe();
    loop {
        tokio::select! {
            event = receiver.recv() => {
                let message = match event {
                    Ok(event) => event,
                    // Missed events: the client reloads the chat it shows.
                    Err(broadcast::error::RecvError::Lagged(_)) => json!({"type":"resync"}),
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if socket.send(Message::Text(message.to_string().into())).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                if !matches!(incoming, Some(Ok(_))) {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Conversation {
        Conversation {
            id: "1b8ab544-8cc5-430e-8a40-0aec58bc3b10".into(),
            agent: "claude".into(),
            session: "1b8ab544-8cc5-430e-8a40-0aec58bc3b10".into(),
            title: "Plan \"dinner\": ideas".into(),
            created: "2026-10-03T10:00:00Z".into(),
            updated: "2026-10-03T10:01:00Z".into(),
            entries: vec![
                Entry { role: "user".into(), time: "2026-10-03T10:00:00Z".into(), name: String::new(), text: "Ideas for dinner?\n\nSomething quick.".into() },
                Entry { role: "tool".into(), time: "2026-10-03T10:00:02Z".into(), name: "WebSearch".into(), text: "quick dinner recipes".into() },
                Entry {
                    role: "assistant".into(),
                    time: "2026-10-03T10:00:05Z".into(),
                    name: String::new(),
                    text: "**Pasta** is quick.\n\n```\n<!-- omarchy-chat:user 2026 -->\n  <!-- omarchy-chat:tool x y -->\n```\n**You**".into(),
                },
            ],
        }
    }

    #[test]
    fn conversations_round_trip_through_markdown() {
        let conversation = sample();
        let markdown = conversation.to_markdown();
        assert!(markdown.starts_with("---\nid: \"1b8ab544-8cc5-430e-8a40-0aec58bc3b10\"\n"));
        assert!(markdown.contains("**You**\n\nIdeas for dinner?"));
        assert!(markdown.contains("> quick dinner recipes"));
        // Marker-like lines in a message cannot start a new entry.
        assert_eq!(markdown.matches(&format!("\n{MARK}")).count(), 3);
        assert_eq!(Conversation::parse(&markdown).unwrap(), conversation);
        assert_eq!(
            conversation.preview(),
            "**Pasta** is quick. ``` <!-- omarchy-chat:user 2026 --> <!-- omarchy-chat:tool x y --> ``` **You**"
        );
    }

    #[test]
    fn unreadable_files_are_rejected() {
        assert!(Conversation::parse("no front matter").is_none());
        assert!(Conversation::parse("---\nid: \"not-a-uuid\"\n---\n").is_none());
        assert!(Conversation::parse("---\nid: unquoted\n---\n").is_none());
    }

    #[test]
    fn titles_slugs_and_timestamps() {
        assert_eq!(
            title("\n  What is   the best way\nsecond line"),
            "What is the best way"
        );
        assert_eq!(title(&"word ".repeat(30)).chars().count(), 60);
        assert_eq!(
            slug("Plan \"dinner\": ideas for a Tuesday night in"),
            "plan-dinner-ideas-for-a-tuesday"
        );
        assert_eq!(slug("¿Qué?"), "qu");
        assert_eq!(slug("…"), "chat");
        assert_eq!(timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(timestamp(1_696_334_400), "2023-10-03T12:00:00Z");
        assert_eq!(timestamp(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn stream_events_become_entries_and_deltas() {
        let mut live = Live {
            conversation: Conversation {
                id: "id".into(),
                ..Conversation::default()
            },
            path: PathBuf::new(),
            busy: true,
            partial: String::new(),
            seq: 0,
            message: String::new(),
            used: Instant::now(),
            stopping: false,
        };
        let delta = |text: &str| json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":text}}});
        assert_eq!(live.apply(&delta("Hel"))[0]["seq"], 1);
        live.apply(&delta("lo"));
        assert_eq!(live.partial, "Hello");
        // Thinking deltas and blocks are never shown.
        assert!(live.apply(&json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"x"}}})).is_empty());
        let block = |message: &str, content: Value| json!({"type":"assistant","parent_tool_use_id":null,"message":{"id":message,"content":[content]}});
        assert!(
            live.apply(&block(
                "m1",
                json!({"type":"thinking","thinking":"private"})
            ))
            .is_empty()
        );
        let events = live.apply(&block("m1", json!({"type":"text","text":"Hello"})));
        assert_eq!(events[0]["entry"]["text"], "Hello");
        assert_eq!(live.partial, "");
        live.apply(&block(
            "m1",
            json!({"type":"tool_use","name":"WebSearch","input":{"query":"weather   today"}}),
        ));
        // Text after a tool in the same message starts a new entry; a later block of the same
        // message as the last entry joins it.
        live.apply(&block("m2", json!({"type":"text","text":"Sunny."})));
        let joined = live.apply(&block("m2", json!({"type":"text","text":"Warm, too."})));
        assert_eq!(joined[0]["index"], 2);
        // Worker (subagent) messages stay out of the conversation.
        assert!(live.apply(&json!({"type":"assistant","parent_tool_use_id":"t","message":{"id":"w","content":[{"type":"text","text":"worker"}]}})).is_empty());
        let roles: Vec<_> = live
            .conversation
            .entries
            .iter()
            .map(|e| (e.role.as_str(), e.text.as_str()))
            .collect();
        assert_eq!(
            roles,
            [
                ("assistant", "Hello"),
                ("tool", "weather today"),
                ("assistant", "Sunny.\n\nWarm, too.")
            ]
        );
        let done = live.apply(
            &json!({"type":"result","subtype":"success","is_error":false,"result":"Sunny."}),
        );
        assert_eq!(done[0], json!({"type":"done","id":"id","error":null}));
        assert!(!live.busy);
        live.busy = true;
        let failed = live.apply(&json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Out of usage"]}));
        assert_eq!(failed[0]["error"], "Out of usage");
    }

    #[test]
    fn saving_is_private_and_listing_reads_headers() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::dictation::AudioDir::new().unwrap();
        let folder = folder(&dir.0).unwrap();
        assert_eq!(
            fs::metadata(&folder).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let conversation = sample();
        let path = folder.join("2026-10-03-plan-dinner-ideas-1b8ab544.md");
        save(&conversation, &path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(find(&folder, &conversation.id).unwrap(), path);
        assert!(find(&folder, "2c8ab544-8cc5-430e-8a40-0aec58bc3b10").is_err());
        assert!(find(&folder, "../escape").is_err());
        assert_eq!(load(&path).unwrap(), conversation);
        fs::write(folder.join("notes.md"), "# not a chat").unwrap();
        let chats = list(&folder);
        assert_eq!(chats.len(), 1);
        assert_eq!(chats[0]["title"], "Plan \"dinner\": ideas");
        assert_eq!(chats[0]["preview"], conversation.preview());
    }
}
