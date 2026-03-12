import { useState, useCallback, useRef, useEffect } from "react";
import { Copy, Check, ChevronDown, ChevronRight } from "lucide-react";
import hljs from "highlight.js";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export default function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const lineCount = code.split("\n").length;
  const isLong = lineCount > 30;

  useEffect(() => {
    if (codeRef.current && language) {
      try {
        hljs.highlightElement(codeRef.current);
      } catch {
        // ignore
      }
    }
  }, [code, language]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="relative group my-3 rounded-xl overflow-hidden border border-border bg-code-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-code-header border-b border-border text-xs">
        <div className="flex items-center gap-2">
          {isLong && (
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="text-text-muted hover:text-text-primary transition-colors"
            >
              {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
          <span className="text-text-muted font-medium">
            {language || "text"}
          </span>
          <span className="text-text-muted/50">{lineCount} lines</span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md
                     text-text-muted hover:text-text-primary hover:bg-black/5
                     transition-colors"
        >
          {copied ? (
            <>
              <Check size={12} className="text-success" /> Copied
            </>
          ) : (
            <>
              <Copy size={12} /> Copy
            </>
          )}
        </button>
      </div>
      {/* Code */}
      {!collapsed && (
        <div className="overflow-x-auto">
          <pre className="p-4 text-[0.85rem] leading-[1.6]">
            <code
              ref={codeRef}
              className={language ? `language-${language}` : ""}
            >
              {code}
            </code>
          </pre>
        </div>
      )}
      {collapsed && (
        <div className="px-4 py-2 text-xs text-text-muted italic">
          {lineCount} lines collapsed
        </div>
      )}
    </div>
  );
}
