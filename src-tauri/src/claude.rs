use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

// ── PATH resolution ──────────────────────────────────────────────────

fn get_shell_path() -> &'static str {
    static CACHED_PATH: OnceLock<String> = OnceLock::new();
    CACHED_PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        if let Ok(output) = Command::new(&shell)
            .args(["-ilc", "echo $PATH"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return path;
                }
            }
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/user".to_string());
        format!(
            "/opt/homebrew/bin:/usr/local/bin:{}/.nvm/versions/node/default/bin:{}/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            home, home
        )
    })
}

fn command_with_path(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", get_shell_path());
    cmd.env_remove("CLAUDECODE");
    cmd
}

// ── Debug event helper ───────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct DebugEvent {
    pub session_id: String,
    pub level: String,
    pub message: String,
    pub timestamp: u64,
}

fn emit_debug(app: &AppHandle, session_id: &str, level: &str, message: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let _ = app.emit(
        "claude-debug",
        DebugEvent {
            session_id: session_id.to_string(),
            level: level.to_string(),
            message: message.to_string(),
            timestamp: ts,
        },
    );
}

// ── State ────────────────────────────────────────────────────────────

pub struct ProcessManager {
    /// frontend session id -> real claude session id (from stream-json output)
    claude_sessions: Arc<Mutex<HashMap<String, String>>>,
    /// frontend session id -> child PID (for stopping)
    running_pids: Arc<Mutex<HashMap<String, u32>>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            claude_sessions: Arc::new(Mutex::new(HashMap::new())),
            running_pids: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct StreamPayload {
    pub session_id: String,
    pub data: String,
    pub done: bool,
    pub error: Option<String>,
    pub stream: String,
}

#[derive(Deserialize)]
pub struct SendMessageRequest {
    pub session_id: String,
    pub message: String,
    pub cwd: String,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub claude_path: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn check_claude_installed(claude_path: Option<String>) -> Result<String, String> {
    let cmd = claude_path.unwrap_or_else(|| "claude".to_string());
    match command_with_path(&cmd).arg("--version").output() {
        Ok(output) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                Err(format!(
                    "claude CLI error: {}",
                    String::from_utf8_lossy(&output.stderr)
                ))
            }
        }
        Err(e) => Err(format!("claude CLI not found at '{}': {}", cmd, e)),
    }
}

/// Send a message using `claude -p "msg" --output-format stream-json --verbose`.
/// Uses --resume for multi-turn conversations.
#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    request: SendMessageRequest,
) -> Result<u32, String> {
    let claude_cmd = request.claude_path.unwrap_or_else(|| "claude".to_string());
    let session_id = request.session_id.clone();

    let mut args: Vec<String> = vec![
        "-p".to_string(),
        request.message.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];

    // Multi-turn: use --resume with real claude session id
    {
        let sessions = state.claude_sessions.lock().map_err(|e| e.to_string())?;
        if let Some(real_id) = sessions.get(&session_id) {
            args.push("--resume".to_string());
            args.push(real_id.clone());
            emit_debug(&app, &session_id, "info", &format!("--resume {}", real_id));
        } else {
            emit_debug(&app, &session_id, "info", "First message (no --resume)");
        }
    }

    if let Some(ref model) = request.model {
        if !model.is_empty() {
            args.push("--model".to_string());
            args.push(model.clone());
        }
    }

    if let Some(ref mode) = request.permission_mode {
        if !mode.is_empty() {
            args.push("--permission-mode".to_string());
            args.push(mode.clone());
        }
    }

    if let Some(ref tools) = request.allowed_tools {
        if !tools.is_empty() {
            for tool in tools {
                args.push("--allowedTools".to_string());
                args.push(tool.clone());
            }
        }
    }

    let full_cmd = format!("{} {}", claude_cmd, args.iter().enumerate().map(|(i, a)| {
        if i == 1 { format!("\"{}\"", if a.len() > 60 { format!("{}...", &a[..60]) } else { a.clone() }) }
        else { a.clone() }
    }).collect::<Vec<_>>().join(" "));
    emit_debug(&app, &session_id, "process", &format!("$ {}", full_cmd));
    emit_debug(&app, &session_id, "info", &format!("cwd: {}", request.cwd));

    let mut child = command_with_path(&claude_cmd)
        .args(&args)
        .current_dir(&request.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| {
            let msg = format!("Failed to spawn: {}", e);
            emit_debug(&app, &session_id, "error", &msg);
            msg
        })?;

    let pid = child.id();
    emit_debug(&app, &session_id, "process", &format!("Started PID {}", pid));

    // Track PID
    {
        let mut pids = state.running_pids.lock().map_err(|e| e.to_string())?;
        pids.insert(session_id.clone(), pid);
    }

    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    // Clone Arcs for background threads
    let sessions_arc = Arc::clone(&state.claude_sessions);
    let pids_arc = Arc::clone(&state.running_pids);

    // stdout reader thread
    let app_out = app.clone();
    let sid_out = session_id.clone();
    let sessions_for_stdout = Arc::clone(&sessions_arc);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    emit_debug(&app_out, &sid_out, "stdout", &line);

                    // Extract real claude session_id from "system" init message
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                        if val.get("type").and_then(|t| t.as_str()) == Some("system") {
                            if let Some(sid) = val.get("session_id").and_then(|s| s.as_str()) {
                                emit_debug(&app_out, &sid_out, "info",
                                    &format!("Claude session_id: {}", sid));
                                if let Ok(mut sessions) = sessions_for_stdout.lock() {
                                    sessions.insert(sid_out.clone(), sid.to_string());
                                }
                            }
                        }
                    }

                    let payload = StreamPayload {
                        session_id: sid_out.clone(),
                        data: line,
                        done: false,
                        error: None,
                        stream: "stdout".to_string(),
                    };
                    let _ = app_out.emit("claude-stream", &payload);
                }
                Err(e) => {
                    emit_debug(&app_out, &sid_out, "error", &format!("stdout error: {}", e));
                    break;
                }
            }
        }

        // Process finished
        emit_debug(&app_out, &sid_out, "process", "Process exited (stdout closed)");
        let _ = app_out.emit("claude-stream", &StreamPayload {
            session_id: sid_out.clone(),
            data: String::new(),
            done: true,
            error: None,
            stream: "stdout".to_string(),
        });

        // Clean up PID
        if let Ok(mut pids) = pids_arc.lock() {
            pids.remove(&sid_out);
        }
    });

    // stderr reader thread
    let app_err = app.clone();
    let sid_err = session_id.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    emit_debug(&app_err, &sid_err, "stderr", &line);
                    let _ = app_err.emit("claude-stream", &StreamPayload {
                        session_id: sid_err.clone(),
                        data: line,
                        done: false,
                        error: None,
                        stream: "stderr".to_string(),
                    });
                }
                Err(_) => break,
            }
        }
    });

    Ok(pid)
}

/// Stop a running claude process
#[tauri::command]
pub fn stop_session(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    session_id: String,
) -> Result<(), String> {
    let mut pids = state.running_pids.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = pids.remove(&session_id) {
        emit_debug(&app, &session_id, "process", &format!("Killing PID {}", pid));
        unsafe { libc::kill(pid as i32, libc::SIGTERM); }
    }
    Ok(())
}

/// Get the current git branch for a directory
#[tauri::command]
pub fn get_git_branch(cwd: String) -> Result<String, String> {
    let output = command_with_path("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err("Not a git repository".to_string())
    }
}

/// Open a URL in the system default browser
#[tauri::command]
pub fn open_in_browser(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// List directory entries
#[derive(Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    let dir = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    for entry in dir.flatten() {
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}
