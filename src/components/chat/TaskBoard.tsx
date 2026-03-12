import { useState } from "react";
import { useTaskStore } from "../../stores/taskStore";
import {
  CheckCircle2,
  Circle,
  Loader2,
  ListTodo,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface TaskBoardProps {
  sessionId: string | null;
}

export default function TaskBoard({ sessionId }: TaskBoardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { tasks } = useTaskStore();
  const sessionTasks = tasks.filter((t) => t.sessionId === sessionId);

  if (sessionTasks.length === 0) return null;

  const completed = sessionTasks.filter((t) => t.status === "completed").length;
  const total = sessionTasks.length;
  const hasInProgress = sessionTasks.some((t) => t.status === "in_progress");

  return (
    <div className="border-t border-border bg-bg-secondary/30 px-4 py-2">
      <div className="max-w-3xl mx-auto">
        {/* Header — always visible, clickable to toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 w-full"
        >
          {collapsed ? (
            <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
          ) : (
            <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
          )}
          <ListTodo size={13} className="text-accent flex-shrink-0" />
          <span className="text-xs font-medium text-text-secondary">
            Tasks
          </span>
          <span className="text-xs text-text-muted">
            {completed}/{total}
          </span>
          {/* Spinning indicator when collapsed and has in-progress tasks */}
          {collapsed && hasInProgress && (
            <Loader2 size={12} className="text-warning animate-spin flex-shrink-0" />
          )}
          {/* Progress bar */}
          <div className="flex-1 h-1 bg-border rounded-full overflow-hidden ml-1">
            <div
              className="h-full bg-accent rounded-full transition-all duration-500"
              style={{ width: `${(completed / total) * 100}%` }}
            />
          </div>
        </button>

        {/* Task list — collapsible */}
        {!collapsed && (
          <div className="space-y-0.5 max-h-32 overflow-y-auto mt-1.5">
            {sessionTasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-2 py-0.5 text-sm"
              >
                {task.status === "completed" ? (
                  <CheckCircle2
                    size={14}
                    className="text-success flex-shrink-0"
                  />
                ) : task.status === "in_progress" ? (
                  <Loader2
                    size={14}
                    className="text-warning flex-shrink-0 animate-spin"
                  />
                ) : (
                  <Circle
                    size={14}
                    className="text-text-muted flex-shrink-0"
                  />
                )}
                <span
                  className={`truncate ${
                    task.status === "completed"
                      ? "line-through text-text-muted"
                      : task.status === "in_progress"
                      ? "text-warning"
                      : "text-text-secondary"
                  }`}
                >
                  {task.subject}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
