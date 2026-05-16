import path from "node:path";

import type { StorageAdapter } from "@/lib/storage/storage-adapter";
import { SqliteStorageAdapter } from "@/lib/storage/sqlite-storage-adapter";
import { TsLocalStorageAdapter } from "@/lib/storage/ts-local-storage-adapter";

type SupportedBackend = "sqlite" | "json";

type ResolveStorageOptions<TState> = {
  seedFactory: () => TState;
};

function parseBackend(value: string | undefined): SupportedBackend {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sqlite") return "sqlite";
  return "json";
}

export function resolvePlatformStateStorage<TState>(options: ResolveStorageOptions<TState>): {
  backend: SupportedBackend;
  storage: StorageAdapter<TState>;
} {
  const backend = parseBackend(process.env.TS_PLATFORM_STATE_BACKEND);

  if (backend === "sqlite") {
    const sqlitePath =
      process.env.TS_PLATFORM_STATE_SQLITE_PATH?.trim() || path.join(process.cwd(), ".data", "ts-platform-state.sqlite");
    return {
      backend,
      storage: new SqliteStorageAdapter<TState>({
        filePath: sqlitePath,
        seedFactory: options.seedFactory
      })
    };
  }

  const jsonPath =
    process.env.TS_PLATFORM_STATE_PATH?.trim() || path.join(process.cwd(), ".data", "ts-platform-state.json");
  return {
    backend,
    storage: new TsLocalStorageAdapter<TState>({
      filePath: jsonPath,
      seedFactory: options.seedFactory
    })
  };
}
