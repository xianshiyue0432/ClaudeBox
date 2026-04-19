export type SkillSource = "builtin" | "plugin" | "global" | "project";

export interface SkillDef {
  name: string;
  desc: string;
}

export interface SkillCategory {
  key: string;
  label: string;
  skills: SkillDef[];
}

const DESCRIPTIONS: Record<string, string> = {
  commit: "创建规范的 Git 提交",
  init: "初始化 CLAUDE.md",
  review: "审查 Pull Request",
  "code-review": "代码审查 PR",
  "security-review": "安全审查当前分支",
  simplify: "精简和优化代码",
  "update-config": "配置 settings.json",
  "keybindings-help": "自定义快捷键",
  "less-permission-prompts": "减少权限弹窗",
  loop: "循环执行任务",
  schedule: "定时执行远程代理",
  "claude-api": "构建 Claude API 应用",
  "claude-code-setup": "分析并推荐自动化配置",
};

const DEV_SKILLS = new Set([
  "commit", "init", "review", "code-review", "security-review", "simplify",
]);

const CLAUDE_SKILLS = new Set([
  "update-config", "keybindings-help", "less-permission-prompts",
  "loop", "schedule", "claude-api", "claude-code-setup",
]);

function builtinCategory(name: string): string {
  if (DEV_SKILLS.has(name)) return "dev";
  if (CLAUDE_SKILLS.has(name)) return "claude";
  return "builtin_other";
}

const CATEGORY_LABELS: Record<string, string> = {
  project: "项目技能",
  global: "全局技能",
  dev: "开发",
  claude: "Claude Code",
  plugin: "插件",
  builtin_other: "其他",
};

const CATEGORY_ORDER = ["project", "global", "dev", "claude", "plugin", "builtin_other"];

export function parseSkills(
  names: string[],
  sources?: Record<string, SkillSource>,
): SkillCategory[] {
  const groups: Record<string, SkillDef[]> = {};

  for (const name of names) {
    const src = sources?.[name];
    let cat: string;
    if (src === "project") cat = "project";
    else if (src === "global") cat = "global";
    else if (src === "plugin") cat = "plugin";
    else cat = builtinCategory(name);

    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({
      name,
      desc: DESCRIPTIONS[name] || name,
    });
  }

  return CATEGORY_ORDER
    .filter((key) => groups[key]?.length)
    .map((key) => ({
      key,
      label: CATEGORY_LABELS[key] || key,
      skills: groups[key],
    }));
}
