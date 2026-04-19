import { create } from "zustand";
import { preloadSkills, listDir, emitDebug } from "../lib/claude-ipc";
import { useSettingsStore } from "./settingsStore";
import type { SkillDef, SkillSource } from "../lib/skills";

interface SkillsState {
  globalSkills: SkillDef[];
  globalSources: Record<string, SkillSource>;
  projectSkills: Record<string, string[]>;
  loading: boolean;
  loadedAt: number | null;
  error: string | null;

  preloadGlobal: () => Promise<void>;
  scanProject: (projectPath: string) => Promise<void>;
  refresh: (projectPath?: string) => Promise<void>;
  updateFromSession: (skills: SkillDef[], sources: Record<string, SkillSource>) => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  globalSkills: [],
  globalSources: {},
  projectSkills: {},
  loading: false,
  loadedAt: null,
  error: null,

  preloadGlobal: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    emitDebug("info", "[skills] preloadGlobal started");
    try {
      const { apiKey, baseUrl } = useSettingsStore.getState().settings;
      const raw = await preloadSkills(apiKey || undefined, baseUrl || undefined);
      emitDebug("info", `[skills] preloadSkills returned ${raw.length} bytes`);
      const data = JSON.parse(raw);
      if (data.type === "skills" && Array.isArray(data.skills)) {
        emitDebug("info", `[skills] loaded ${data.skills.length} global skills`);
        set({
          globalSkills: data.skills,
          globalSources: data.skillSources || {},
          loadedAt: Date.now(),
        });
      }
    } catch (err) {
      emitDebug("error", `[skills] preloadGlobal failed: ${err}`);
      set({ error: String(err) });
    } finally {
      set({ loading: false });
    }
  },

  scanProject: async (projectPath: string) => {
    if (get().projectSkills[projectPath]) return;
    try {
      const skillsDir = `${projectPath}/.claude/skills`;
      const entries = await listDir(skillsDir);
      const names = entries.filter((e) => e.is_dir).map((e) => e.name);
      set((s) => ({
        projectSkills: { ...s.projectSkills, [projectPath]: names },
      }));
    } catch {
      set((s) => ({
        projectSkills: { ...s.projectSkills, [projectPath]: [] },
      }));
    }
  },

  refresh: async (projectPath?: string) => {
    set({ loadedAt: null, error: null });
    if (projectPath) {
      set((s) => {
        const ps = { ...s.projectSkills };
        delete ps[projectPath];
        return { projectSkills: ps };
      });
      await get().scanProject(projectPath);
    }
    await get().preloadGlobal();
  },

  updateFromSession: (skills, sources) => {
    const globalSkills = skills.filter((s) => sources[s.name] !== "project");
    const globalSources: Record<string, SkillSource> = {};
    for (const s of globalSkills) {
      if (sources[s.name]) globalSources[s.name] = sources[s.name];
    }
    set({ globalSkills, globalSources, loadedAt: Date.now() });
  },
}));
