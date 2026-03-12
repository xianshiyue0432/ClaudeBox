import { useState, useEffect } from "react";
import { X, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { checkClaudeInstalled } from "../../lib/claude-ipc";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onClaudeStatusChange: (available: boolean) => void;
}

export default function SettingsDialog({
  open,
  onClose,
  onClaudeStatusChange,
}: SettingsDialogProps) {
  const { settings, updateSettings } = useSettingsStore();
  const [claudeVersion, setClaudeVersion] = useState<string | null>(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const checkClaude = async () => {
    setChecking(true);
    setClaudeError(null);
    try {
      const version = await checkClaudeInstalled(
        settings.claudePath || undefined
      );
      setClaudeVersion(version);
      setClaudeError(null);
      onClaudeStatusChange(true);
    } catch (err) {
      setClaudeVersion(null);
      setClaudeError(String(err));
      onClaudeStatusChange(false);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (open) checkClaude();
  }, [open, settings.claudePath]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-primary border border-border rounded-2xl w-[480px] max-h-[80vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 space-y-5">
          {/* Claude CLI Status */}
          <div>
            <label className="text-sm font-medium text-text-primary block mb-2">
              Claude CLI Status
            </label>
            <div className="flex items-center gap-2 text-sm">
              {checking ? (
                <>
                  <Loader2
                    size={14}
                    className="animate-spin text-text-muted"
                  />
                  <span className="text-text-muted">Checking...</span>
                </>
              ) : claudeVersion ? (
                <>
                  <CheckCircle size={14} className="text-success" />
                  <span className="text-success">{claudeVersion}</span>
                </>
              ) : (
                <>
                  <XCircle size={14} className="text-error" />
                  <span className="text-error text-xs">
                    {claudeError || "Not found"}
                  </span>
                </>
              )}
              <button
                onClick={checkClaude}
                className="ml-auto text-xs text-accent hover:text-accent-hover transition-colors"
              >
                Re-check
              </button>
            </div>
          </div>

          {/* Claude CLI Path */}
          <div>
            <label className="text-sm font-medium text-text-primary block mb-1.5">
              Claude CLI Path
            </label>
            <input
              type="text"
              value={settings.claudePath}
              onChange={(e) => updateSettings({ claudePath: e.target.value })}
              placeholder="claude"
              className="w-full rounded-lg bg-input-bg border border-border px-3 py-2 text-sm
                         text-text-primary placeholder:text-text-muted
                         focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
            <p className="text-xs text-text-muted mt-1">
              Path to claude CLI binary. Use "claude" for global install.
            </p>
          </div>

          {/* Default Model */}
          <div>
            <label className="text-sm font-medium text-text-primary block mb-1.5">
              Default Model
            </label>
            <select
              value={settings.model}
              onChange={(e) => updateSettings({ model: e.target.value })}
              className="w-full rounded-lg bg-input-bg border border-border px-3 py-2 text-sm
                         text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              <option value="">Default (Sonnet)</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="haiku">Haiku</option>
            </select>
            <p className="text-xs text-text-muted mt-1">
              Can be overridden per session when opening a project.
            </p>
          </div>

          {/* Default Permission Mode */}
          <div>
            <label className="text-sm font-medium text-text-primary block mb-1.5">
              Default Permission Mode
            </label>
            <select
              value={settings.permissionMode}
              onChange={(e) =>
                updateSettings({ permissionMode: e.target.value })
              }
              className="w-full rounded-lg bg-input-bg border border-border px-3 py-2 text-sm
                         text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              <option value="">Default</option>
              <option value="auto">Auto Accept</option>
              <option value="plan">Plan Mode</option>
            </select>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg bg-accent text-white hover:bg-accent-hover
                       transition-colors text-sm font-medium"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
