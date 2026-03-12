import { useEffect, useRef, useCallback, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { sendMessage, stopSession, onStream, getGitBranch } from "../../lib/claude-ipc";
import MessageBubble from "./MessageBubble";
import InputArea from "./InputArea";
import TaskBoard from "./TaskBoard";
import FileTree from "./FileTree";
import { Sparkles, FolderOpen, Terminal, GitBranch, PanelRightClose, PanelRight } from "lucide-react";

interface ChatPanelProps {
  claudeAvailable: boolean;
}

export default function ChatPanel({ claudeAvailable }: ChatPanelProps) {
  const {
    currentSessionId,
    sessions,
    messages,
    stderrLogs,
    isStreaming,
    streamError,
    streamStartTimes,
    addUserMessage,
    addSystemMessage,
    handleStreamData,
    handleStreamDone,
    setStreaming,
    clearError,
    updateSession,
  } = useChatStore();

  const { settings } = useSettingsStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [showFilePanel, setShowFilePanel] = useState(false);

  // Fetch git branch when session changes
  useEffect(() => {
    setGitBranch(null);
    if (currentSession?.projectPath) {
      getGitBranch(currentSession.projectPath)
        .then((branch) => setGitBranch(branch))
        .catch(() => setGitBranch(null));
    }
  }, [currentSession?.projectPath]);

  useEffect(() => {
    const unlisten = onStream((payload) => {
      if (payload.done) {
        handleStreamDone(payload.session_id, payload.error ?? undefined);
      } else if (payload.data) {
        handleStreamData(payload.session_id, payload.data, payload.stream);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [handleStreamData, handleStreamDone]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentSessionId]);

  const handleSend = useCallback(
    async (content: string) => {
      if (!currentSessionId || !currentSession) return;
      addUserMessage(currentSessionId, content);
      setStreaming(true);
      clearError();
      try {
        const pid = await sendMessage({
          session_id: currentSessionId,
          message: content,
          cwd: currentSession.projectPath,
          model: currentSession.model || undefined,
          permission_mode: currentSession.permissionMode || undefined,
          claude_path: settings.claudePath || undefined,
          allowed_tools: currentSession.allowedTools?.length
            ? currentSession.allowedTools
            : undefined,
        });
        addSystemMessage(currentSessionId, `Task started, PID: ${pid}`);
      } catch (err) {
        handleStreamDone(currentSessionId, String(err));
      }
    },
    [currentSessionId, currentSession, settings.claudePath, addUserMessage, addSystemMessage, setStreaming, clearError, handleStreamDone]
  );

  const handleStop = useCallback(async () => {
    if (currentSessionId) {
      try { await stopSession(currentSessionId); } catch { /* ignore */ }
    }
  }, [currentSessionId]);

  const handleModelChange = useCallback(
    (model: string) => {
      if (currentSessionId) updateSession(currentSessionId, { model });
    },
    [currentSessionId, updateSession]
  );

  const handlePermissionModeChange = useCallback(
    (permissionMode: string) => {
      if (currentSessionId) updateSession(currentSessionId, { permissionMode });
    },
    [currentSessionId, updateSession]
  );

  const handleAllowedToolsChange = useCallback(
    (allowedTools: string[]) => {
      if (currentSessionId) updateSession(currentSessionId, { allowedTools });
    },
    [currentSessionId, updateSession]
  );

  const currentMessages = currentSessionId
    ? messages[currentSessionId] || []
    : [];
  const currentStderr = currentSessionId
    ? stderrLogs[currentSessionId] || []
    : [];

  // Compute total tokens for the current turn (all assistant messages after last user message)
  const totalTokens = (() => {
    let tokens = 0;
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const m = currentMessages[i];
      if (m.role === "user") break;
      if (m.role === "assistant" && m.usage) {
        tokens += m.usage.input_tokens + m.usage.output_tokens;
      }
    }
    return tokens;
  })();

  // Compute duration from stream start
  const streamStartTime = currentSessionId ? streamStartTimes[currentSessionId] : undefined;

  // No session — welcome
  if (!currentSessionId) {
    return (
      <div className="flex-1 flex flex-col h-full">
        {/* Draggable titlebar area */}
        <div
          data-tauri-drag-region
          className="h-12 flex-shrink-0"
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center px-8">
            <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-4">
              <Sparkles size={32} className="text-accent" />
            </div>
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              Welcome to ClaudeBox
            </h2>
            <p className="text-text-secondary text-sm max-w-md mb-4">
              Open a project folder to start a Claude Code session.
            </p>
            <div className="flex items-center gap-2 justify-center text-text-muted text-xs">
              <FolderOpen size={14} />
              <span>Click &quot;Open Project&quot; in the sidebar to begin</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Session header (also draggable) */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-bg-secondary/50 h-12 flex-shrink-0"
      >
        <FolderOpen size={14} className="text-text-muted pointer-events-none" />
        <span className="text-sm text-text-secondary truncate pointer-events-none flex-1">
          {currentSession?.projectPath}
        </span>
        {gitBranch && (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-muted pointer-events-none">
            <GitBranch size={11} />
            {gitBranch}
          </span>
        )}
        <button
          onClick={() => setShowFilePanel(!showFilePanel)}
          className="p-1.5 rounded-lg hover:bg-bg-tertiary/50 text-text-secondary hover:text-text-primary transition-colors"
          title={showFilePanel ? "Close file panel" : "Open file panel"}
        >
          {showFilePanel ? <PanelRightClose size={16} /> : <PanelRight size={16} />}
        </button>
      </div>

      {/* Main content area with optional file panel */}
      <div className="flex-1 flex min-h-0">
        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto py-4">
            <div className="max-w-3xl mx-auto">
              {currentMessages.length === 0 && (
                <div className="text-center py-16 text-text-muted">
                  <Terminal size={24} className="mx-auto mb-2 opacity-50" />
                  <p className="text-sm">
                    Send a message to start working with Claude in this project.
                  </p>
                </div>
              )}
              {currentMessages.map((msg, i) => {
                // Only show bot avatar on the first assistant message in a consecutive group
                let showAvatar = true;
                if (msg.role === "assistant" && i > 0) {
                  const prev = currentMessages[i - 1];
                  if (prev.role === "assistant") showAvatar = false;
                }
                // Check if this is the last assistant message
                const isLastAssistant =
                  msg.role === "assistant" &&
                  !currentMessages.slice(i + 1).some((m) => m.role === "assistant");
                return (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    allMessages={currentMessages}
                    messageIndex={i}
                    showAvatar={showAvatar}
                    isLastAssistant={isLastAssistant}
                    sessionStreaming={isStreaming}
                    totalTokens={totalTokens}
                    streamStartTime={streamStartTime}
                  />
                );
              })}
            </div>

            {streamError && (
              <div className="max-w-3xl mx-auto px-4 mb-4">
                <div className="rounded-lg bg-error/10 border border-error/30 px-4 py-3 text-error text-sm">
                  {streamError}
                </div>
              </div>
            )}

            {currentStderr.length > 0 && (
              <details className="max-w-3xl mx-auto px-4 mb-4">
                <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary">
                  stderr ({currentStderr.length})
                </summary>
                <pre className="mt-1 text-xs bg-code-bg rounded p-2 max-h-32 overflow-y-auto text-text-muted">
                  {currentStderr.slice(-50).join("\n")}
                </pre>
              </details>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Task Board (above input) */}
          <TaskBoard sessionId={currentSessionId} />

          {/* Input */}
          <InputArea
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            disabled={!claudeAvailable}
            model={currentSession?.model || ""}
            permissionMode={currentSession?.permissionMode || ""}
            onModelChange={handleModelChange}
            onPermissionModeChange={handlePermissionModeChange}
            gitBranch={gitBranch}
            allowedTools={currentSession?.allowedTools || []}
            onAllowedToolsChange={handleAllowedToolsChange}
          />
        </div>

        {/* File panel */}
        {showFilePanel && currentSession?.projectPath && (
          <div className="w-64 border-l border-border bg-bg-secondary flex-shrink-0">
            <FileTree rootPath={currentSession.projectPath} />
          </div>
        )}
      </div>
    </div>
  );
}
