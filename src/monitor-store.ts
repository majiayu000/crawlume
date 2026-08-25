import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ReadError } from "./errors.js";
import type {
  PageMonitor,
  PageMonitorFailureRun,
  PageMonitorInput,
  PageMonitorRun,
  PageMonitorStatus,
  PageMonitorSuccessRun,
} from "./types.js";

type MonitorRow = {
  id: string;
  status: PageMonitorStatus;
  input_json: string;
  interval_seconds: number;
  created_at_ms: number;
  started_at_ms: number | null;
  next_run_at_ms: number | null;
  last_content_hash: string | null;
  last_changed_at_ms: number | null;
  run_count: number;
  change_count: number;
  failure_count: number;
  last_run_json: string | null;
};

function rowToMonitor(row: MonitorRow): PageMonitor {
  return {
    id: row.id,
    status: row.status,
    input: JSON.parse(row.input_json) as PageMonitorInput,
    intervalSeconds: row.interval_seconds,
    createdAt: new Date(row.created_at_ms).toISOString(),
    startedAt: row.started_at_ms === null ? null : new Date(row.started_at_ms).toISOString(),
    nextRunAt: row.next_run_at_ms === null ? null : new Date(row.next_run_at_ms).toISOString(),
    lastContentHash: row.last_content_hash,
    lastChangedAt: row.last_changed_at_ms === null
      ? null
      : new Date(row.last_changed_at_ms).toISOString(),
    runCount: row.run_count,
    changeCount: row.change_count,
    failureCount: row.failure_count,
    lastRun: row.last_run_json === null
      ? null
      : JSON.parse(row.last_run_json) as PageMonitorRun,
  };
}

export class PageMonitorStore {
  private readonly database: DatabaseSync;

  constructor(
    path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS page_monitors (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('scheduled', 'running', 'cancelled')),
        input_json TEXT NOT NULL,
        interval_seconds INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        next_run_at_ms INTEGER,
        last_content_hash TEXT,
        last_changed_at_ms INTEGER,
        run_count INTEGER NOT NULL DEFAULT 0,
        change_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_run_json TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS page_monitors_due
      ON page_monitors(status, next_run_at_ms);
    `);
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }
  }

  create(input: PageMonitorInput, intervalSeconds: number): PageMonitor {
    const id = randomUUID();
    const now = this.now();
    this.database
      .prepare(
        `INSERT INTO page_monitors(
           id, status, input_json, interval_seconds, created_at_ms, next_run_at_ms
         ) VALUES (?, 'scheduled', ?, ?, ?, ?)`,
      )
      .run(id, JSON.stringify(input), intervalSeconds, now, now);
    return this.require(id);
  }

  get(id: string): PageMonitor | null {
    const row = this.database.prepare("SELECT * FROM page_monitors WHERE id = ?").get(id) as
      | MonitorRow
      | undefined;
    return row === undefined ? null : rowToMonitor(row);
  }

  require(id: string): PageMonitor {
    const monitor = this.get(id);
    if (monitor === null) {
      throw new ReadError("MONITOR_NOT_FOUND", "The page monitor does not exist.", {
        details: { monitorId: id },
      });
    }
    return monitor;
  }

  list(limit: number): PageMonitor[] {
    const rows = this.database
      .prepare("SELECT * FROM page_monitors ORDER BY created_at_ms DESC, id DESC LIMIT ?")
      .all(limit) as unknown as MonitorRow[];
    return rows.map(rowToMonitor);
  }

  claimDue(): PageMonitor | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now();
      const row = this.database
        .prepare(
          `SELECT id FROM page_monitors
           WHERE status = 'scheduled' AND next_run_at_ms <= ?
           ORDER BY next_run_at_ms, created_at_ms, id LIMIT 1`,
        )
        .get(now) as { id: string } | undefined;
      if (row === undefined) {
        this.database.exec("COMMIT");
        return null;
      }
      const changed = this.database
        .prepare(
          `UPDATE page_monitors
           SET status = 'running', started_at_ms = ?, next_run_at_ms = NULL
           WHERE id = ? AND status = 'scheduled'`,
        )
        .run(now, row.id).changes;
      this.database.exec("COMMIT");
      return changed === 1 ? this.require(row.id) : null;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  nextDueAt(): number | null {
    const row = this.database
      .prepare(
        `SELECT MIN(next_run_at_ms) AS next_due_at
         FROM page_monitors WHERE status = 'scheduled'`,
      )
      .get() as { next_due_at: number | null };
    return row.next_due_at;
  }

  completeSuccess(id: string, run: PageMonitorSuccessRun): PageMonitor {
    const completedAt = Date.parse(run.completedAt);
    const monitor = this.require(id);
    const changeIncrement = run.changed === true ? 1 : 0;
    const changedAt = run.changed === true ? completedAt : monitor.lastChangedAt === null
      ? null
      : Date.parse(monitor.lastChangedAt);
    const changed = this.database
      .prepare(
        `UPDATE page_monitors
         SET status = 'scheduled', started_at_ms = NULL,
             next_run_at_ms = ?, last_content_hash = ?, last_changed_at_ms = ?,
             run_count = run_count + 1, change_count = change_count + ?,
             last_run_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        completedAt + monitor.intervalSeconds * 1_000,
        run.contentHash,
        changedAt,
        changeIncrement,
        JSON.stringify(run),
        id,
      ).changes;
    return this.finishResult(id, Number(changed), "success");
  }

  completeFailure(id: string, run: PageMonitorFailureRun): PageMonitor {
    const completedAt = Date.parse(run.completedAt);
    const monitor = this.require(id);
    const changed = this.database
      .prepare(
        `UPDATE page_monitors
         SET status = 'scheduled', started_at_ms = NULL, next_run_at_ms = ?,
             run_count = run_count + 1, failure_count = failure_count + 1,
             last_run_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        completedAt + monitor.intervalSeconds * 1_000,
        JSON.stringify(run),
        id,
      ).changes;
    return this.finishResult(id, Number(changed), "failure");
  }

  cancel(id: string): PageMonitor {
    this.require(id);
    this.database
      .prepare(
        `UPDATE page_monitors
         SET status = 'cancelled', started_at_ms = NULL, next_run_at_ms = NULL
         WHERE id = ? AND status != 'cancelled'`,
      )
      .run(id);
    return this.require(id);
  }

  isCancelled(id: string): boolean {
    return this.require(id).status === "cancelled";
  }

  requeue(id: string): void {
    this.database
      .prepare(
        `UPDATE page_monitors
         SET status = 'scheduled', started_at_ms = NULL, next_run_at_ms = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(this.now(), id);
  }

  recoverInterrupted(): void {
    this.database
      .prepare(
        `UPDATE page_monitors
         SET status = 'scheduled', started_at_ms = NULL, next_run_at_ms = ?
         WHERE status = 'running'`,
      )
      .run(this.now());
  }

  close(): void {
    this.database.close();
  }

  private finishResult(id: string, changed: number, outcome: string): PageMonitor {
    if (changed === 1) {
      return this.require(id);
    }
    const monitor = this.require(id);
    if (monitor.status === "cancelled") {
      return monitor;
    }
    throw new ReadError("INTERNAL_ERROR", "The page monitor changed state unexpectedly.", {
      details: { monitorId: id, monitorStatus: monitor.status, outcome },
    });
  }
}
