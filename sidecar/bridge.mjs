#!/usr/bin/env node
/**
 * ClaudeBox Sidecar Bridge
 *
 * Bridges the @anthropic-ai/claude-agent-sdk query() API with the Rust
 * backend via NDJSON over stdin/stdout.
 *
 * Protocol (Rust → Sidecar, stdin):
 *   {"type":"start","prompt":"…","cwd":"…","model":"…","resume":"…","allowedTools":[…],"permissionMode":"…"}
 *   {"type":"response","requestId":"req-1","behavior":"allow","answers":{…}}
 *   {"type":"response","requestId":"req-2","behavior":"deny","message":"…"}
 *   {"type":"abort"}
 *
 * Protocol (Sidecar → Rust, stdout):
 *   {"type":"system","subtype":"init","session_id":"…",…}
 *   {"type":"assistant","message":{…}}
 *   {"type":"user","message":{…}}
 *   {"type":"result","session_id":"…","total_cost_usd":…}
 *   {"type":"ask_user","requestId":"req-1","questions":[…]}
 *   {"type":"exit_plan","requestId":"req-2","input":{…}}
 *   {"type":"error","message":"…"}
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";
import { execSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, chmodSync, unlinkSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, extname } from "node:path";
import { spawn } from "node:child_process";

// Providers that use x-api-key (Anthropic-style) instead of Bearer token.
// ALL third-party API proxies use Bearer auth — only official Anthropic uses x-api-key.
const X_API_KEY_PROVIDERS = new Set(["anthropic"]);

/**
 * Detect provider from base URL (fallback when providerId is "custom").
 * Only needs to distinguish Anthropic from third-party APIs for auth header selection.
 * @param {string} baseUrl
 * @returns {string|null}
 */
function detectProviderFromUrl(baseUrl) {
  if (!baseUrl) return null;
  const lower = baseUrl.toLowerCase();
  // Official Anthropic API
  if (lower.includes("anthropic.com") && !lower.includes("kimi")) {
    return "anthropic";
  }
  // Any other URL → treat as third-party (will use Bearer auth)
  return "third-party";
}

// Estimate token count (rough approximation)
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Generate a session ID
function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Build system prompt for workspace boundary and locale
function buildSystemPrompt(cwd, locale) {
  const root = cwd.replace(/\/+$/, "");
  let appendText = `\n## Workspace Boundary (CRITICAL)\nProject root: ${root}\nALL file operations and Bash commands MUST stay within \`${root}/\`. NEVER create/modify files outside it. NEVER invent non-existent directories — verify with ls/Glob first. When unsure, ask the user.`;

  const LOCALE_INSTRUCTIONS = {
    zh: "\n\n## Language\nAlways respond in Chinese (简体中文). All explanations, comments in responses, and conversational text must be in Chinese. Code, file paths, and technical identifiers remain in their original language.",
  };
  if (locale && LOCALE_INSTRUCTIONS[locale]) {
    appendText += LOCALE_INSTRUCTIONS[locale];
  }
  return appendText;
}

/**
 * Build system prompt that includes model identity information.
 * Third-party API proxies may strip or misreport the actual model identity,
 * so we explicitly tell the model what it is.
 */
function buildSystemPromptWithIdentity(cwd, locale, model, providerId) {
  let prompt = buildSystemPrompt(cwd, locale);

  // Inject model identity to ensure correct self-identification
  if (model) {
    const displayName = providerId === "anthropic" ? model : `${model} (${providerId})`;
    prompt += `\n\n## Identity\nYou are the AI model "${displayName}". When asked about your identity, model name, or version, always respond truthfully that you are "${model}". Do NOT claim to be Claude, GPT, or any other model.`;
  }

  return prompt;
}

// Handle streaming API calls with Bearer auth
async function handleBearerAuthQuery({
  prompt,
  cwd,
  model,
  resume,
  allowedTools,
  locale,
  effort,
  contextWindow,
  apiKey,
  baseUrl,
  providerId,
  abortController,
}) {
  const sessionId = generateSessionId();
  const maxTokens = Math.max(estimateTokens(prompt) * 2, 8192);

  // Build the endpoint URL - handle providers that already include /v1 in their base URL
  let baseEndpoint = baseUrl.replace(/\/+$/, "");
  
  // Special handling for Kimi: the base URL might already include the full path
  const isKimi = providerId === "kimi";
  if (isKimi) {
    // Kimi API endpoint: https://api.kimi.com/v1/messages
    // User might set baseUrl as "https://api.kimi.com" or "https://api.kimi.com/v1"
    if (!baseEndpoint.includes("/v1") && !baseEndpoint.endsWith("/messages")) {
      baseEndpoint += "/v1";
    }
  } else if (!baseEndpoint.includes("/v1") && !baseEndpoint.endsWith("/messages")) {
    baseEndpoint += "/v1";
  }
  const endpoint = `${baseEndpoint}/messages`;

  // Build system prompt (as a string for direct API calls)
  // Note: The "preset" format with type/preset/append is SDK-internal,
  // but third-party Anthropic-compatible APIs expect a plain string.
  const systemPrompt = buildSystemPromptWithIdentity(cwd, locale, model, providerId);

  // Build request body
  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: prompt }],
    stream: true,
  };

  // For Kimi/Moonshot compatibility: ensure model name is valid
  if (isKimi) {
    console.error(`[bridge] Kimi model requested: "${model}"`);
    // Common Kimi model names: kimi-latest, moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k
    // If user passes a Claude model name, it will fail - but we let the API return the error
  }

  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };

  // Use Bearer auth for all providers except Anthropic (which uses x-api-key)
  // This ensures any new third-party provider works out-of-the-box
  const useXApiKey = X_API_KEY_PROVIDERS.has(providerId);
  if (useXApiKey) {
    headers["x-api-key"] = apiKey;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Emit system init message
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    cwd,
    status: "authentication_confirmed",
  });

  console.error(`[bridge] === Bearer Auth Request ===`);
  console.error(`[bridge] endpoint: ${endpoint}`);
  console.error(`[bridge] model: ${model}`);
  console.error(`[bridge] providerId: ${providerId}`);
  console.error(`[bridge] apiKey present: ${!!apiKey}`);
  console.error(`[bridge] baseUrl: ${baseUrl}`);
  console.error(`[bridge] Request headers: ${JSON.stringify(headers)}`);
  console.error(`[bridge] Request body: ${JSON.stringify(body)}`);
  console.error(`[bridge] ==============================`);

  // Timeout wrapper for fetch (5 minute timeout for long-running models like Kimi)
  const timeoutMs = 300000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs)
  );

  let response;
  try {
    console.error(`[bridge] Starting fetch to ${endpoint}`);
    console.error(`[bridge] Full request body: ${JSON.stringify(body)}`);
    response = await Promise.race([
      fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      }),
      timeoutPromise,
    ]);
    console.error(`[bridge] Fetch completed, status: ${response.status}`);
    console.error(`[bridge] Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = `HTTP ${response.status}: ${errorText}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.message) {
          errorMsg = errorJson.error.message;
        } else if (errorJson.message) {
          errorMsg = errorJson.message;
        }
      } catch {}
      console.error(`[bridge] HTTP error response: ${errorMsg}`);
      console.error(`[bridge] Raw error body: ${errorText.slice(0, 500)}`);
      throw new Error(errorMsg);
    }

    console.error(`[bridge] Response OK, starting stream processing`);
    // Handle streaming response
    const reader = response.body.getReader();
    let buffer = "";
    let currentContent = "";
    let currentThinking = "";  // Accumulate thinking content separately
    let stopReason = null;
    let messageId = `msg_${Date.now()}`;

    // Read stream
    const readStream = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = new TextDecoder().decode(value, { stream: true });
        buffer += chunk;

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          // Handle SSE format: "data:{...}" or "data: {...}" or plain NDJSON: "{...}"
          // Note: Some APIs (e.g., Kimi) use "data:" WITHOUT space after the colon
          let jsonStr = line;
          if (line.startsWith("data:")) {
            jsonStr = line.replace(/^data:\s*/, "");
          } else if (!line.startsWith("{")) {
            continue;
          }

          try {
            const event = JSON.parse(jsonStr);
            console.error(`[bridge] Received event type: ${event.type}, delta_type: ${event.delta?.type || "N/A"}`);
            if (event.type === "message_start") {
              messageId = event.message?.id || messageId;
              console.error(`[bridge] Message started, id: ${messageId}, model: ${event.message?.model}`);
            } else if (event.type === "content_block_start") {
              // Assistant message start
              console.error(`[bridge] Content block started, type: ${event.content_block?.type}`);
            } else if (event.type === "content_block_delta") {
              console.error(`[bridge] Content delta type: ${event.delta?.type}`);
              if (event.delta?.type === "text_delta") {
                currentContent += event.delta.text;
                console.error(`[bridge] Text delta, content length: ${currentContent.length}`);

                // Emit ONLY the text block — let chatStore's appendNewBlocks handle merging.
                // This avoids sending [text, thinking] array every time which creates duplicate blocks.
                emit({
                  type: "assistant",
                  message: {
                    id: messageId,
                    role: "assistant",
                    content: [
                      { type: "text", text: currentContent },
                    ],
                    model,
                    stop_reason: null,
                    usage: null,
                  },
                });
              } else if (event.delta?.type === "thinking_delta") {
                // Accumulate thinking content and emit as a single ContentBlock
                currentThinking += event.delta.thinking || "";

                // Emit ONLY the thinking block — chatStore will merge with existing thinking block
                emit({
                  type: "assistant",
                  message: {
                    id: messageId,
                    role: "assistant",
                    content: [
                      { type: "thinking", thinking: currentThinking },
                    ],
                    model,
                    stop_reason: null,
                    usage: null,
                  },
                });
              }
            } else if (event.type === "content_block_stop") {
              // Content block done
              console.error(`[bridge] Content block stopped`);
            } else if (event.type === "message_delta") {
              if (event.delta?.stop_reason) {
                stopReason = event.delta.stop_reason;
                console.error(`[bridge] Stop reason: ${stopReason}`);
              }
            } else if (event.type === "message_stop") {
              // Message complete
              console.error(`[bridge] Message stopped`);
            }
          } catch (e) {
            // Ignore parse errors for partial lines
            console.error(`[bridge] Parse error: ${e.message}, line: ${line.slice(0, 100)}`);
          }
        }
      }

      // Final flush - emit complete message with proper content blocks
      const finalContentBlocks = [];
      if (currentThinking) {
        finalContentBlocks.push({ type: "thinking", thinking: currentThinking });
      }
      if (currentContent) {
        finalContentBlocks.push({ type: "text", text: currentContent });
      }

      // Emit final message
      emit({
        type: "assistant",
        message: {
          id: messageId,
          role: "assistant",
          content: finalContentBlocks.length > 0 ? finalContentBlocks : currentContent,
          model,
          stop_reason: stopReason,
          usage: null,
        },
      });

      // Emit result
      emit({
        type: "result",
        subtype: "success",
        session_id: sessionId,
        result: { message: currentContent },
        is_error: false,
        total_cost_usd: 0,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
      });
      console.error(`[bridge] handleBearerAuthQuery completed successfully`);
    };

    await readStream();
    console.error(`[bridge] readStream completed`);
  } catch (err) {
    console.error(`[bridge] ERROR: ${err.message}`);
    console.error(`[bridge] Error name: ${err.name}`);
    console.error(`[bridge] Error stack: ${err.stack}`);
    if (err.name === "AbortError") {
      emit({ type: "result", subtype: "aborted", is_error: false });
    } else {
      // Emit error event AND result event so frontend knows stream ended
      emitError(`Bearer API error: ${err.message}`);
      emit({
        type: "result",
        subtype: "error",
        session_id: sessionId,
        result: { message: "" },
        is_error: true,
        total_cost_usd: 0,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 0,
      });
    }
  }
}

// ── File attachment helpers ─────────────────────────────────────────

/**
 * Process attachments into prompt text.
 * - Text files → read content, embed as fenced code blocks
 * - Images → include file path so Claude Code uses its Read tool to view them
 * @param {Array<{path: string, name: string, type: string}>} attachments
 * @returns {string} Text to append to the prompt
 */
function processAttachments(attachments) {
  const parts = [];

  for (const att of attachments) {
    try {
      if (att.type === "image") {
        // Let Claude Code's Read tool handle image files — it supports
        // reading images (PNG, JPG, etc.) and presenting them visually.
        parts.push(`[Attached image: ${att.path}]`);
      } else {
        // Text / code file — read and embed inline
        const content = readFileSync(att.path, "utf-8");
        const ext = extname(att.name).replace(/^\./, "") || "text";
        parts.push(`\`\`\`${ext} title="${att.name}"\n${content}\n\`\`\``);
      }
    } catch (e) {
      console.error(`[bridge] Failed to read attachment ${att.path}: ${e.message}`);
      parts.push(`[Failed to read file: ${att.name} — ${e.message}]`);
    }
  }

  return parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
}

// ── Pre-flight & diagnostics ────────────────────────────────────────

/** Build a clean env (no CLAUDECODE) for the SDK child process */
function cleanEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

function preflight() {
  // Check CLAUDECODE env var
  if (process.env.CLAUDECODE) {
    console.error(`[bridge] WARNING: CLAUDECODE=${process.env.CLAUDECODE} found, will be removed for child`);
  }

  // Check claude is accessible
  try {
    const ver = execSync("claude --version", {
      encoding: "utf-8",
      timeout: 5000,
      env: cleanEnv(),
      windowsHide: true,
    }).trim();
    console.error(`[bridge] claude --version: ${ver}`);
  } catch (e) {
    console.error(`[bridge] claude --version FAILED: ${e.message}`);
    if (e.stderr) console.error(`[bridge] stderr: ${e.stderr}`);
  }
}

/**
 * Create a wrapper script around `claude` that tees stderr to a temp file.
 * Returns { wrapperPath, stderrPath, cleanup }.
 * On Windows, creates a .mjs Node script (so the SDK runs it via `node`,
 * avoiding the EINVAL error that occurs when spawn()-ing .cmd files on
 * newer Node.js versions due to CVE-2024-27980).
 * On Unix, creates a bash script.
 */
function createClaudeWrapper() {
  const isWindows = process.platform === "win32";
  const dir = mkdtempSync(join(tmpdir(), "claudebox-"));
  const stderrPath = join(dir, "claude-stderr.log");

  // Find real claude path
  let claudePath = "claude";
  try {
    const findCmd = isWindows ? "where claude" : "which claude";
    const found = execSync(findCmd, { encoding: "utf-8", env: cleanEnv(), windowsHide: true }).trim();
    // `where` on Windows may return multiple lines; take the first
    claudePath = found.split(/\r?\n/)[0];
  } catch { /* use default */ }

  let wrapperPath;
  if (isWindows) {
    // Windows: .mjs Node script wrapper.
    // The Agent SDK checks the file extension:
    //   - .cmd/.exe/etc → spawn(path, args) directly → EINVAL on Windows
    //   - .mjs/.js/etc  → spawn("node", [path, ...args]) → works fine
    // The wrapper spawns claude with shell:true so .cmd shims work.
    wrapperPath = join(dir, "claude-wrapper.mjs");
    const wrapperScript = `
import { spawn } from "child_process";
import { createWriteStream } from "fs";

const claudePath = ${JSON.stringify(claudePath)};
const stderrPath = ${JSON.stringify(stderrPath)};
const args = process.argv.slice(2);
const stderrFile = createWriteStream(stderrPath, { flags: "a" });

const child = spawn(claudePath, args, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: true,
  windowsHide: true,
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.on("data", (chunk) => stderrFile.write(chunk));

child.on("exit", (code, signal) => {
  stderrFile.end(() => process.exit(code ?? (signal ? 1 : 0)));
});
child.on("error", (err) => {
  stderrFile.write(err.message + "\\n");
  stderrFile.end(() => process.exit(1));
});

// Forward termination signals to child
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
`;
    writeFileSync(wrapperPath, wrapperScript.trimStart());
  } else {
    // Unix: bash script with tee to capture stderr while keeping it visible
    wrapperPath = join(dir, "claude-wrapper.sh");
    writeFileSync(wrapperPath, `#!/bin/bash\nexec "${claudePath}" "$@" 2> >(tee "${stderrPath}" >&2)\n`);
    chmodSync(wrapperPath, 0o755);
  }

  return {
    wrapperPath,
    stderrPath,
    cleanup() {
      try { unlinkSync(wrapperPath); } catch {}
      try { unlinkSync(stderrPath); } catch {}
    },
    readStderr() {
      try {
        return readFileSync(stderrPath, "utf-8");
      } catch { return ""; }
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function listSkillDirs(dir) {
  try {
    return readdirSync(dir).filter((name) => {
      try { return statSync(join(dir, name)).isDirectory(); } catch { return false; }
    });
  } catch { return []; }
}

function scanSkillSources(cwd, skills) {
  const globalDir = join(homedir(), ".claude", "skills");
  const projectDir = cwd ? join(cwd, ".claude", "skills") : null;
  const globalSet = new Set(listSkillDirs(globalDir));
  const isSameDir = projectDir && projectDir === globalDir;
  const projectSet = (projectDir && !isSameDir) ? new Set(listSkillDirs(projectDir)) : new Set();
  const sources = {};
  for (const name of skills) {
    if (projectSet.has(name)) sources[name] = "project";
    else if (globalSet.has(name)) sources[name] = "global";
    else if (name.includes(":")) sources[name] = "plugin";
    else sources[name] = "builtin";
  }
  return sources;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitError(message) {
  emit({ type: "error", message: String(message) });
}

/** Emit detailed error info from Error objects */
function emitDetailedError(err) {
  const parts = [];
  parts.push(err.message || String(err));
  if (err.cause) parts.push(`Cause: ${err.cause.message || err.cause}`);
  if (err.stderr) parts.push(`Stderr: ${err.stderr}`);
  if (err.code) parts.push(`Code: ${err.code}`);
  if (err.exitCode !== undefined) parts.push(`Exit code: ${err.exitCode}`);
  emitError(parts.join(" | "));
}

// ── Pending permission requests ─────────────────────────────────────

let requestCounter = 0;
/** @type {Map<string, { resolve: (val: any) => void }>} */
const pendingRequests = new Map();

function nextRequestId() {
  return `req-${++requestCounter}`;
}

/** Reject all pending requests (e.g. on stdin close or abort) */
function rejectAllPending(reason) {
  for (const [, { resolve }] of pendingRequests) {
    resolve({ behavior: "deny", message: reason });
  }
  pendingRequests.clear();
}

// ── stdin reader ────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });
/** @type {((line: string) => void) | null} */
let onFirstLine = null;
let stdinCloseAllowed = true;

rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;

  // First line is handled by the startup code
  if (onFirstLine) {
    const cb = onFirstLine;
    onFirstLine = null;
    cb(line);
    return;
  }

  try {
    const msg = JSON.parse(line);

    if (msg.type === "response" && msg.requestId) {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        pendingRequests.delete(msg.requestId);
        pending.resolve(msg);
      }
      return;
    }

    if (msg.type === "abort") {
      rejectAllPending("Session aborted");
      if (activeAbort) activeAbort.abort();
      return;
    }
  } catch {
    // ignore malformed lines
  }
});

rl.on("close", () => {
  if (!stdinCloseAllowed) return;
  // stdin closed — reject pending requests and abort any running query
  rejectAllPending("Session terminated");
  if (activeAbort) activeAbort.abort();
  process.exit(0);
});

// ── Main ────────────────────────────────────────────────────────────

/** @type {AbortController | null} */
let activeAbort = null;

/**
 * Wait for a response from Rust for a given requestId.
 * @param {string} requestId
 * @returns {Promise<any>}
 */
function waitForResponse(requestId) {
  return new Promise((resolve) => {
    pendingRequests.set(requestId, { resolve });
  });
}

/**
 * canUseTool callback — intercepts AskUserQuestion and ExitPlanMode.
 * For other tools: auto-allow if in allowedTools list, otherwise ask user.
 */
function makeCanUseTool(allowedTools, cwd) {
  const allowedSet = new Set(allowedTools);

  return async (toolName, input, _options) => {
    // AskUserQuestion — send to frontend, wait for user answer
    if (toolName === "AskUserQuestion") {
      // Fix: model sometimes sends questions as a JSON string instead of array
      let questions = input.questions || [];
      if (typeof questions === "string") {
        try {
          questions = JSON.parse(questions);
        } catch {
          console.error(`[bridge] Failed to parse questions string: ${questions.slice(0, 200)}`);
          questions = [];
        }
      }

      const requestId = nextRequestId();
      emit({
        type: "ask_user",
        requestId,
        questions,
      });
      const resp = await waitForResponse(requestId);
      if (resp.behavior === "allow") {
        return {
          behavior: "allow",
          updatedInput: {
            ...input,
            questions, // ensure it's the parsed array
            answers: resp.answers || {},
            annotations: resp.annotations,
          },
        };
      }
      return { behavior: "deny", message: resp.message || "User cancelled" };
    }

    // ExitPlanMode — read plan content from input, send to frontend, wait for approval
    if (toolName === "ExitPlanMode") {
      let planContent = "";
      if (input.plan) {
        planContent = input.plan;
      } else if (input.planFilePath) {
        try {
          planContent = readFileSync(input.planFilePath, "utf-8");
          console.error(`[bridge] Read plan from planFilePath: ${input.planFilePath}`);
        } catch (e) {
          console.error(`[bridge] Failed to read planFilePath: ${e.message}`);
        }
      }
      if (!planContent) {
        try {
          planContent = findLatestPlanContent(cwd);
        } catch (e) {
          console.error(`[bridge] Fallback findLatestPlanContent failed: ${e.message}`);
        }
      }

      const requestId = nextRequestId();
      emit({
        type: "exit_plan",
        requestId,
        input,
        planContent,
      });
      const resp = await waitForResponse(requestId);
      if (resp.behavior === "allow") {
        return { behavior: "allow", updatedInput: input };
      }
      return {
        behavior: "deny",
        message: resp.message || "Plan rejected by user",
      };
    }

    // Tool in allowedTools → auto-approve without prompting
    if (allowedSet.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    // MCP tools — auto-approve if "MCP" wildcard is in allowedTools
    if (toolName.startsWith("mcp__") && allowedSet.has("MCP")) {
      return { behavior: "allow", updatedInput: input };
    }

    // Tool NOT in allowedTools → ask user for permission
    const requestId = nextRequestId();
    emit({
      type: "tool_permission",
      requestId,
      toolName,
      input,
    });
    const resp = await waitForResponse(requestId);
    if (resp.behavior === "allow") {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: resp.message || "User denied tool use" };
  };
}

/**
 * Find and read the most recently modified plan file from .claude/plans/
 */
function findLatestPlanContent(cwd) {
  // Plans are stored in ~/.claude/projects/{project-key}/plans/ or in the project's .claude/plans/
  const searchDirs = [];

  // 1. Project-local .claude/plans/
  if (cwd) {
    searchDirs.push(join(cwd, ".claude", "plans"));
  }

  // 2. Global ~/.claude/projects/ (search for directories matching the cwd)
  const globalBase = join(homedir(), ".claude", "projects");
  try {
    for (const entry of readdirSync(globalBase)) {
      const plansDir = join(globalBase, entry, "plans");
      try {
        statSync(plansDir);
        searchDirs.push(plansDir);
      } catch { /* not a dir */ }
    }
  } catch { /* no global projects dir */ }

  // Find the most recently modified .md file across all search dirs
  let latestFile = null;
  let latestMtime = 0;

  for (const dir of searchDirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const fullPath = join(dir, file);
        const st = statSync(fullPath);
        if (st.mtimeMs > latestMtime) {
          latestMtime = st.mtimeMs;
          latestFile = fullPath;
        }
      }
    } catch { /* dir doesn't exist */ }
  }

  if (latestFile) {
    console.error(`[bridge] Reading plan file: ${latestFile}`);
    return readFileSync(latestFile, "utf-8");
  }

  return "";
}

async function main() {
  // Startup diagnostic - emit immediately so we can see if bridge starts
  console.error(`[bridge] BRIDGE_STARTING`);
  process.stderr.write(`[bridge] BRIDGE_STARTING via stderr\n`);

  // Capture stderr from SDK internals for diagnostics
  const stderrChunks = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(String(chunk));
    // Keep last 50 lines
    if (stderrChunks.length > 50) stderrChunks.shift();
    return origStderrWrite(chunk, ...args);
  };

  // Wait for the first "start" message from Rust
  const startMsg = await new Promise((resolve) => {
    onFirstLine = (line) => {
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        emitError(`Invalid start message: ${e.message}`);
        process.exit(1);
      }
    };
  });

  console.error(`[bridge] STARTUP: Received start message type=${startMsg.type}`);
  process.stderr.write(`[bridge] START_MESSAGE_RECEIVED\n`);

  if (startMsg.type !== "start" && startMsg.type !== "list_skills") {
    emitError(`Expected 'start' or 'list_skills' message, got '${startMsg.type}'`);
    process.exit(1);
  }

  // ── list_skills: one-shot skill enumeration, no conversation ──
  if (startMsg.type === "list_skills") {
    stdinCloseAllowed = false;
    try {
      const wrapper = createClaudeWrapper();
      const abortController = new AbortController();
      const opts = {
        abortController,
        cwd: startMsg.cwd || homedir(),
        env: cleanEnv(),
        pathToClaudeCodeExecutable: wrapper.wrapperPath,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
      };
      if (startMsg.model) opts.model = startMsg.model;
      const conversation = query({ prompt: " ", options: opts });
      const commands = await conversation.supportedCommands();
      const skills = commands.map((c) => ({ name: c.name, desc: c.description || c.name }));
      const sources = scanSkillSources(opts.cwd, commands.map((c) => c.name));
      emit({ type: "skills", skills, skillSources: sources });
      abortController.abort();
      wrapper.cleanup?.();
    } catch (err) {
      emitError(`list_skills failed: ${err.message}`);
    }
    process.exit(0);
  }

  // ── Normal start flow ──

  const {
    prompt,
    cwd,
    model,
    resume,
    allowedTools,
    permissionMode,
    attachments,
    locale,
    effort,
    contextWindow,
    apiKey,
    baseUrl,
    providerId,
  } = startMsg;

  // Log config for diagnostics (to stderr, which Rust captures)
  console.error(`[bridge] model=${model || "(default)"} cwd=${cwd} permissionMode=${permissionMode || "(default)"} contextWindow=${contextWindow || "200k"}`);
  console.error(`[bridge] apiKey=${apiKey ? "set (" + apiKey.slice(0, 10) + "...)" : "NOT SET"}`);
  console.error(`[bridge] baseUrl=${baseUrl || "NOT SET"}`);
  console.error(`[bridge] providerId=${providerId || "NOT SET"}`);

  // Detect provider from URL if not explicitly provided or is "custom"
  const effectiveProviderId = (providerId && providerId !== "custom")
    ? providerId
    : (detectProviderFromUrl(baseUrl) || providerId || "anthropic");
  console.error(`[bridge] effectiveProviderId=${effectiveProviderId}`);

  // Check if this provider requires Bearer auth (all non-Anthropic providers)
  const useBearerAuth = !X_API_KEY_PROVIDERS.has(effectiveProviderId) && apiKey && baseUrl;
  console.error(`[bridge] Bearer auth check: providerId=${providerId}, effectiveProviderId=${effectiveProviderId}, hasKey=${!!apiKey}, hasUrl=${!!baseUrl}, useBearer=${useBearerAuth}`);

  if (useBearerAuth) {
    console.error(`[bridge] Using Bearer auth flow for ${effectiveProviderId}`);

    const abortController = new AbortController();
    activeAbort = abortController;

    console.error(`[bridge] CALLING handleBearerAuthQuery now`);
    await handleBearerAuthQuery({
      prompt,
      cwd,
      model,
      resume,
      allowedTools,
      locale,
      effort,
      contextWindow,
      apiKey,
      baseUrl,
      providerId: effectiveProviderId,
      abortController,
    });
    console.error(`[bridge] handleBearerAuthQuery returned, exiting`);

    process.exit(0);
  }

  // Run pre-flight diagnostics
  preflight();

  // Create wrapper to capture claude CLI stderr
  const wrapper = createClaudeWrapper();
  console.error(`[bridge] Using claude wrapper: ${wrapper.wrapperPath}`);

  const abortController = new AbortController();
  activeAbort = abortController;

  /** @type {import("@anthropic-ai/claude-agent-sdk").Options} */
  const options = {
    abortController,
    canUseTool: makeCanUseTool(allowedTools || [], cwd),
    // Pass clean env without CLAUDECODE
    env: cleanEnv(),
    // Use wrapper to capture stderr
    pathToClaudeCodeExecutable: wrapper.wrapperPath,
    // Explicitly set settingSources to avoid the SDK generating an empty
    // `--setting-sources ""` arg.  On Windows the wrapper uses shell:true,
    // cmd.exe drops the empty string, and `--permission-mode` gets consumed
    // as a setting-source value → "Invalid setting source: --permission-mode".
    settingSources: ["user", "project", "local"],
  };

  if (cwd) options.cwd = cwd;
  if (model) options.model = model;
  if (effort) options.effort = effort;
  if (contextWindow === "1m") options.betas = ["context-1m-2025-08-07"];
  if (resume) options.resume = resume;
  if (permissionMode) options.permissionMode = permissionMode;
  if (allowedTools && allowedTools.length > 0) {
    const sdkTools = allowedTools.filter((t) => t !== "MCP");
    if (sdkTools.length > 0) {
      options.allowedTools = sdkTools;
    }
  }

  // Workspace boundary — prevent Claude from writing outside the project
  if (cwd) {
    const root = cwd.replace(/\/+$/, "");
    let appendText = `\n## Workspace Boundary (CRITICAL)\nProject root: ${root}\nALL file operations and Bash commands MUST stay within \`${root}/\`. NEVER create/modify files outside it. NEVER invent non-existent directories — verify with ls/Glob first. When unsure, ask the user.`;

    // Language instruction based on UI locale
    const LOCALE_INSTRUCTIONS = {
      zh: "\n\n## Language\nAlways respond in Chinese (简体中文). All explanations, comments in responses, and conversational text must be in Chinese. Code, file paths, and technical identifiers remain in their original language.",
    };
    if (locale && LOCALE_INSTRUCTIONS[locale]) {
      appendText += LOCALE_INSTRUCTIONS[locale];
    }

    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: appendText,
    };
  }

  try {
    // Process file attachments — append to prompt as text
    let finalPrompt = prompt;

    if (attachments && attachments.length > 0) {
      finalPrompt = prompt + processAttachments(attachments);
      console.error(`[bridge] Processed ${attachments.length} attachment(s)`);
    }

    const conversation = query({ prompt: finalPrompt, options });

    // Fetch available skills (with descriptions) from SDK control API
    conversation.supportedCommands().then((commands) => {
      const skills = commands.map((c) => ({ name: c.name, desc: c.description || c.name }));
      const sources = scanSkillSources(options.cwd, commands.map((c) => c.name));
      emit({ type: "skills", skills, skillSources: sources });
    }).catch((err) => {
      console.error("[bridge] Failed to fetch supported commands:", err.message);
    });

    for await (const message of conversation) {
      // Emit messages in a format compatible with the existing stream-json output
      switch (message.type) {
        case "system": {
          emit({
            type: "system",
            subtype: message.subtype,
            session_id: message.session_id,
            tools: message.tools,
            model: message.model,
            cwd: message.cwd,
            status: message.status,
            compact_metadata: message.compact_metadata,
          });
          break;
        }

        case "assistant": {
          // The assistant message — contains Anthropic BetaMessage
          const m = message.message;
          emit({
            type: "assistant",
            message: {
              id: m.id,
              role: m.role,
              content: m.content,
              model: m.model,
              stop_reason: m.stop_reason,
              usage: m.usage,
            },
          });
          break;
        }

        case "user": {
          // Tool result messages
          const m = message.message;
          emit({
            type: "user",
            message: {
              role: "user",
              content: Array.isArray(m.content) ? m.content : m,
            },
          });
          break;
        }

        case "result": {
          emit({
            type: "result",
            subtype: message.subtype,
            session_id: message.session_id,
            result: message.result,
            is_error: message.is_error,
            total_cost_usd: message.total_cost_usd,
            duration_ms: message.duration_ms,
            duration_api_ms: message.duration_api_ms,
            num_turns: message.num_turns,
          });
          break;
        }

        default:
          // Other message types (status, auth, etc.) — skip for now
          break;
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      emit({ type: "result", subtype: "aborted", is_error: false });
    } else {
      // Dump ALL error properties for debugging
      const allProps = {};
      for (const key of Object.getOwnPropertyNames(err)) {
        try {
          const val = err[key];
          if (typeof val !== "function") allProps[key] = val;
        } catch { /* ignore */ }
      }

      const parts = [err.message || String(err)];
      if (err.cause) {
        const causeMsg = typeof err.cause === "object"
          ? JSON.stringify(err.cause, Object.getOwnPropertyNames(err.cause))
          : String(err.cause);
        parts.push(`Cause: ${causeMsg}`);
      }
      if (err.stderr) parts.push(`Stderr: ${err.stderr}`);
      if (err.code) parts.push(`Code: ${err.code}`);
      if (err.exitCode !== undefined) parts.push(`ExitCode: ${err.exitCode}`);

      // Append captured stderr for context
      const recentStderr = stderrChunks.join("").trim();
      if (recentStderr) {
        parts.push(`\nBridge stderr:\n${recentStderr.slice(-1000)}`);
      }

      // Read claude CLI stderr captured by wrapper script
      const capturedStderr = wrapper.readStderr();
      if (capturedStderr) {
        parts.push(`\nClaude CLI stderr:\n${capturedStderr.slice(-2000)}`);
      }

      // Append full error dump
      parts.push(`\nError properties: ${JSON.stringify(allProps).slice(0, 2000)}`);

      emitError(parts.join(" | "));
    }
  }

  wrapper.cleanup();
  process.exit(0);
}

main().catch((err) => {
  emitDetailedError(err);
  process.exit(1);
});
