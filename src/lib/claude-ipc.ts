import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { StreamPayload, DebugEvent } from "./stream-parser";

export interface SendMessageRequest {
  session_id: string;
  message: string;
  cwd: string;
  model?: string;
  permission_mode?: string;
  claude_path?: string;
  allowed_tools?: string[];
}

/** Send a message (spawns claude -p per message, with --resume for multi-turn). Returns PID. */
export async function sendMessage(request: SendMessageRequest): Promise<number> {
  return invoke("send_message", { request });
}

/** Stop a running claude process */
export async function stopSession(sessionId: string): Promise<void> {
  return invoke("stop_session", { sessionId });
}

/** Check if Claude CLI is installed */
export async function checkClaudeInstalled(
  claudePath?: string
): Promise<string> {
  return invoke("check_claude_installed", { claudePath: claudePath ?? null });
}

/** Get current git branch for a directory */
export async function getGitBranch(cwd: string): Promise<string> {
  return invoke("get_git_branch", { cwd });
}

/** Listen for stream events */
export function onStream(
  callback: (payload: StreamPayload) => void
): Promise<UnlistenFn> {
  return listen<StreamPayload>("claude-stream", (event) => {
    callback(event.payload);
  });
}

/** Listen for debug events */
export function onDebug(
  callback: (event: DebugEvent) => void
): Promise<UnlistenFn> {
  return listen<DebugEvent>("claude-debug", (event) => {
    callback(event.payload);
  });
}

/** Open a URL in the system default browser */
export async function openInBrowser(url: string): Promise<void> {
  return invoke("open_in_browser", { url });
}

/** List directory entries */
export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export async function listDir(path: string): Promise<DirEntry[]> {
  return invoke("list_dir", { path });
}
