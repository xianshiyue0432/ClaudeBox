import { create } from "zustand";

export interface Settings {
  model: string;
  permissionMode: string;
  claudePath: string;
  workingDirectory: string;
  theme: "dark" | "light";
}

interface SettingsState {
  settings: Settings;
  updateSettings: (partial: Partial<Settings>) => void;
  loadSettings: () => void;
}

const STORAGE_KEY = "claudebox-settings";

const defaultSettings: Settings = {
  model: "",
  permissionMode: "",
  claudePath: "claude",
  workingDirectory: "",
  theme: "dark",
};

function loadFromStorage(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...defaultSettings, ...JSON.parse(stored) };
    }
  } catch {
    // ignore
  }
  return defaultSettings;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: loadFromStorage(),

  updateSettings: (partial) => {
    const newSettings = { ...get().settings, ...partial };
    set({ settings: newSettings });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
  },

  loadSettings: () => {
    set({ settings: loadFromStorage() });
  },
}));
