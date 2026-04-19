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
  skills: (SkillDef | string)[],
  sources?: Record<string, SkillSource>,
): SkillCategory[] {
  const groups: Record<string, SkillDef[]> = {};

  for (const raw of skills) {
    const skill: SkillDef = typeof raw === "string" ? { name: raw, desc: raw } : raw;
    if (!skill.name) continue;
    const src = sources?.[skill.name];
    let cat: string;
    if (src === "project") cat = "project";
    else if (src === "global") cat = "global";
    else if (src === "plugin") cat = "plugin";
    else cat = builtinCategory(skill.name);

    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(skill);
  }

  return CATEGORY_ORDER
    .filter((key) => groups[key]?.length)
    .map((key) => ({
      key,
      label: CATEGORY_LABELS[key] || key,
      skills: groups[key],
    }));
}
