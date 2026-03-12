/** Types for Claude CLI stream-json output */

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
  is_error?: boolean;
  /** For thinking blocks */
  thinking?: string;
  signature?: string;
  /** For tool_result blocks — references the tool_use id */
  tool_use_id?: string;
}

export interface StreamMessage {
  type: "assistant" | "user" | "system" | "result";
  subtype?: string;
  session_id?: string;
  message?: {
    id?: string;
    role: "assistant" | "user";
    content: ContentBlock[];
    model?: string;
    stop_reason?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  // For result type
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  // For user type — enriched tool result info
  tool_use_result?: {
    stdout?: string;
    stderr?: string;
    type?: string;
    filePath?: string;
    content?: string;
  };
}

export interface StreamPayload {
  session_id: string;
  data: string;
  done: boolean;
  error?: string;
  /** "stdout" or "stderr" */
  stream: string;
}

export interface DebugEvent {
  session_id: string;
  level: string; // "info" | "warn" | "error" | "stdin" | "stdout" | "stderr" | "process"
  message: string;
  timestamp: number;
}

/** Parsed message for display in the UI */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  timestamp: number;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  isStreaming?: boolean;
  /** Track the original stream message id so we can append content blocks for the same turn */
  streamMessageId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}
