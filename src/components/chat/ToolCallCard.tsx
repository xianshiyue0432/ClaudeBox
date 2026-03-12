import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Terminal,
  Search,
  Edit3,
  FolderOpen,
  Globe,
  CheckCircle,
  XCircle,
  Loader2,
  FilePlus,
  NotebookPen,
  Bot,
  ListTodo,
  ExternalLink,
} from "lucide-react";
import type { ContentBlock } from "../../lib/stream-parser";
import { openInBrowser } from "../../lib/claude-ipc";

const TOOL_ICONS: Record<string, React.ReactNode> = {
  Read: <FileText size={14} />,
  Edit: <Edit3 size={14} />,
  Write: <FilePlus size={14} />,
  NotebookEdit: <NotebookPen size={14} />,
  Bash: <Terminal size={14} />,
  Grep: <Search size={14} />,
  Glob: <FolderOpen size={14} />,
  WebFetch: <Globe size={14} />,
  WebSearch: <Globe size={14} />,
  Agent: <Bot size={14} />,
  TaskCreate: <ListTodo size={14} />,
  TaskUpdate: <ListTodo size={14} />,
  TodoWrite: <ListTodo size={14} />,
};

/** Extract a short filename from a full path */
function shortPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, "/").split("/");
  return parts.length > 2
    ? `.../${parts.slice(-2).join("/")}`
    : fullPath;
}

/** Count lines in a string */
function lineCount(s: string): number {
  if (!s) return 0;
  return s.split("\n").length;
}

/** Detect local URLs with ports (e.g. http://localhost:3000) */
function detectLocalUrl(text: string): string | null {
  const match = text.match(
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/\S*)?/
  );
  return match ? match[0].replace("0.0.0.0", "localhost") : null;
}

interface ToolCallCardProps {
  block: ContentBlock;
  result?: ContentBlock;
}

export default function ToolCallCard({ block, result }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const toolName = block.name || "Tool";
  const icon = TOOL_ICONS[toolName] || <Terminal size={14} />;
  const input = block.input || {};
  const isError = result?.is_error;
  const isDone = !!result;

  // Build summary and detail based on tool type
  let summary = toolName;
  let detail = "";

  if (toolName === "Write" || toolName === "NotebookEdit") {
    const fp = (input.file_path || input.notebook_path || "") as string;
    const content = (input.content || input.new_source || "") as string;
    const lines = lineCount(content);
    summary = `${toolName}: ${shortPath(fp)}`;
    detail = `${lines} lines`;
  } else if (toolName === "Edit") {
    const fp = (input.file_path || "") as string;
    const oldStr = (input.old_string || "") as string;
    const newStr = (input.new_string || "") as string;
    const removedLines = lineCount(oldStr);
    const addedLines = lineCount(newStr);
    summary = `Edit: ${shortPath(fp)}`;
    detail = `+${addedLines} / -${removedLines}`;
  } else if (toolName === "Read") {
    const fp = (input.file_path || "") as string;
    summary = `Read: ${shortPath(fp)}`;
  } else if (toolName === "Bash") {
    const cmd = String(input.command || "").trim();
    const desc = input.description as string | undefined;
    // Shorten long absolute paths in commands
    const shortCmd = cmd.replace(/\/\S{40,}/g, (match) => shortPath(match));
    summary = desc || (shortCmd.length > 60 ? shortCmd.slice(0, 60) + "..." : shortCmd);
  } else if (toolName === "Agent") {
    const desc = (input.description || input.prompt || "") as string;
    summary = desc ? `Agent: ${desc.length > 50 ? desc.slice(0, 50) + "..." : desc}` : "Agent";
  } else if (toolName === "Grep" || toolName === "Glob") {
    const pattern = (input.pattern || "") as string;
    summary = `${toolName}: ${pattern}`;
  } else if (input.file_path) {
    summary = `${toolName}: ${shortPath(input.file_path as string)}`;
  } else if (input.command) {
    summary = `${toolName}: ${String(input.command).slice(0, 60)}`;
  } else if (input.url) {
    summary = `${toolName}: ${input.url}`;
  }

  // Extract result text
  let resultText = "";
  if (result) {
    if (typeof result.content === "string") {
      resultText = result.content;
    } else if (Array.isArray(result.content)) {
      resultText = result.content
        .map((c) => (typeof c === "string" ? c : c.text || ""))
        .join("\n");
    }
  }

  // Detect local URL with port in Bash results
  const detectedUrl =
    toolName === "Bash" && resultText ? detectLocalUrl(resultText) : null;

  return (
    <div className="rounded-lg border border-border bg-tool-bg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-bg-secondary/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
        )}
        <span className="text-accent flex-shrink-0">{icon}</span>
        <span className="text-text-secondary truncate flex-1 text-left text-xs">
          {summary}
        </span>
        {detail && (
          <span className="text-text-muted text-[11px] flex-shrink-0 tabular-nums">
            {detail}
          </span>
        )}
        {detectedUrl && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              openInBrowser(detectedUrl);
            }}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px]
                       bg-accent/10 text-accent hover:bg-accent/20 transition-colors flex-shrink-0"
            title={`Open ${detectedUrl}`}
          >
            <ExternalLink size={10} />
            Open
          </span>
        )}
        {isDone ? (
          <span className={isError ? "text-error" : "text-success"}>
            {isError ? <XCircle size={13} /> : <CheckCircle size={13} />}
          </span>
        ) : (
          <Loader2 size={13} className="text-text-muted animate-spin flex-shrink-0" />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-border">
          {/* Input */}
          <div className="mt-2">
            <div className="text-xs text-text-muted mb-1">Input</div>
            <pre className="text-xs bg-code-bg rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {resultText && (
            <div className="mt-2">
              <div className="text-xs text-text-muted mb-1">
                {isError ? "Error" : "Output"}
              </div>
              <pre
                className={`text-xs rounded p-2 overflow-x-auto max-h-48 overflow-y-auto ${
                  isError ? "bg-error/10 text-error" : "bg-code-bg"
                }`}
              >
                {resultText.slice(0, 2000)}
                {resultText.length > 2000 && "\n... (truncated)"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
