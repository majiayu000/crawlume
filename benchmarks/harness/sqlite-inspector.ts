import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type SqliteInspection = {
  integrity: string[];
  tables: string[];
  columnsByTable: Record<string, string[]>;
};

export type FrontierInspectionRow = {
  id: string;
  crawlId: string;
  normalizedUrl: string;
  state: string;
  executionCount: number;
  publicationSequence: number | null;
};

type SqliteTextRow = Record<string, string>;

function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

export async function inspectCrawlDatabase(path: string): Promise<SqliteInspection> {
  await access(path, constants.R_OK);
  const database = openReadOnly(path);
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all() as SqliteTextRow[];
    const tables = database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const columns = database.prepare(
      "SELECT name FROM pragma_table_info(?) ORDER BY cid",
    );
    return {
      integrity: integrity.map((row) => String(Object.values(row)[0])),
      tables: tables.map((row) => row.name),
      columnsByTable: Object.fromEntries(
        tables.map(({ name }) => {
          const rows = columns.all(name) as Array<{ name: string }>;
          return [name, rows.map((row) => row.name)];
        }),
      ),
    };
  } finally {
    database.close();
  }
}

export async function readCrawlJobRow(
  path: string,
  jobId: string,
): Promise<Record<string, unknown> | null> {
  await access(path, constants.R_OK);
  const database = openReadOnly(path);
  try {
    const row = database.prepare("SELECT * FROM crawl_jobs WHERE id = ?").get(jobId);
    return row === undefined ? null : { ...row };
  } finally {
    database.close();
  }
}

export async function readFrontierRows(
  path: string,
  jobId: string,
): Promise<FrontierInspectionRow[]> {
  await access(path, constants.R_OK);
  const database = openReadOnly(path);
  try {
    const rows = database.prepare(
      `SELECT id, crawl_id, normalized_url, state, execution_count, publication_sequence
       FROM crawl_frontier
       WHERE crawl_id = ?
       ORDER BY discovery_sequence, id`,
    ).all(jobId) as Array<{
      id: string;
      crawl_id: string;
      normalized_url: string;
      state: string;
      execution_count: number;
      publication_sequence: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      crawlId: row.crawl_id,
      normalizedUrl: row.normalized_url,
      state: row.state,
      executionCount: row.execution_count,
      publicationSequence: row.publication_sequence,
    }));
  } finally {
    database.close();
  }
}
