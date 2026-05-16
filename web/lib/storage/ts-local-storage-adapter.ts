import fs from "node:fs";
import path from "node:path";

import type { StorageAdapter } from "@/lib/storage/storage-adapter";

export class TsLocalStorageAdapter<TState> implements StorageAdapter<TState> {
  private readonly filePath: string;
  private readonly seedFactory: () => TState;

  constructor(options: { filePath: string; seedFactory: () => TState }) {
    this.filePath = options.filePath;
    this.seedFactory = options.seedFactory;
  }

  read(): TState {
    try {
      if (!fs.existsSync(this.filePath)) {
        const seeded = this.seedFactory();
        this.ensureDir();
        fs.writeFileSync(this.filePath, JSON.stringify(seeded, null, 2), "utf-8");
        return seeded;
      }

      const raw = fs.readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as TState;
    } catch {
      return this.seedFactory();
    }
  }

  write(next: TState): void {
    this.ensureDir();
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf-8");
  }

  update(mutator: (current: TState) => TState): TState {
    const current = this.read();
    const next = mutator(current);
    this.write(next);
    return next;
  }

  private ensureDir() {
    const directory = path.dirname(this.filePath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }
}
