import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import type { AppConfig } from "./types";

export class ConfigStore {
  private readonly rootDir: string;
  private readonly environmentName: string;
  private currentConfig: AppConfig;
  private watcher: FSWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(rootDir: string, config: AppConfig) {
    this.rootDir = rootDir;
    this.environmentName = config.environmentName;
    this.currentConfig = config;
  }

  static async create(rootDir: string): Promise<ConfigStore> {
    const config = await loadConfig(rootDir);
    const store = new ConfigStore(rootDir, config);
    store.startWatching();
    return store;
  }

  getConfig(): AppConfig {
    return this.currentConfig;
  }

  private startWatching(): void {
    const trackedFiles = new Set([
      "config.json".toLowerCase(),
      `config.${this.environmentName}.json`.toLowerCase(),
    ]);

    this.watcher = watch(
      this.rootDir,
      { persistent: false },
      (_eventType, fileName) => {
        if (!fileName) {
          return;
        }

        const normalized = fileName.toString().toLowerCase();
        if (!trackedFiles.has(normalized)) {
          return;
        }

        this.scheduleReload();
      },
    );
  }

  private scheduleReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(() => {
      void this.reload();
    }, 100);
  }

  private async reload(): Promise<void> {
    try {
      const nextConfig = await loadConfig(this.rootDir);
      this.currentConfig = nextConfig;
      console.info(
        `Configuration reloaded from ${path.join(this.rootDir, "config*.json")}`,
      );
    } catch (error) {
      console.error(
        "Configuration reload failed. Keeping previous config.",
        error,
      );
    }
  }
}
