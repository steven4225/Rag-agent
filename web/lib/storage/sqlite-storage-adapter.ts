import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { StorageAdapter } from "@/lib/storage/storage-adapter";

type SqliteStorageAdapterOptions<TState> = {
  filePath: string;
  seedFactory: () => TState;
  tableName?: string;
  key?: string;
};

type PayloadRow = {
  payload: string;
};

export class SqliteStorageAdapter<TState> implements StorageAdapter<TState> {
  private readonly filePath: string;
  private readonly seedFactory: () => TState;
  private readonly tableName: string;
  private readonly key: string;
  private readonly db: DatabaseSync;

  constructor(options: SqliteStorageAdapterOptions<TState>) {
    this.filePath = options.filePath;
    this.seedFactory = options.seedFactory;
    this.tableName = options.tableName ?? "platform_state";
    this.key = options.key ?? "default";
    this.ensureDir();
    this.db = new DatabaseSync(this.filePath);
    this.ensureSchema();
  }

  read(): TState {
    const row = this.db
      .prepare(`SELECT payload FROM ${this.tableName} WHERE state_key = ?`)
      .get(this.key) as PayloadRow | undefined;

    if (!row) {
      const seeded = this.seedFactory();
      this.write(seeded);
      return seeded;
    }

    try {
      return JSON.parse(row.payload) as TState;
    } catch {
      const seeded = this.seedFactory();
      this.write(seeded);
      return seeded;
    }
  }

  write(next: TState): void {
    const payload = JSON.stringify(next);
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO ${this.tableName} (state_key, payload, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE
        SET payload = excluded.payload,
            updated_at = excluded.updated_at
      `
      )
      .run(this.key, payload, updatedAt);
  }

  update(mutator: (current: TState) => TState): TState {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read();
      const next = mutator(current);
      this.write(next);
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        state_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  private ensureDir() {
    const directory = path.dirname(this.filePath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }
}
