import type { Pool } from "pg";

import { logEvent } from "../log.js";
import type { ControlPlaneMigrationClient } from "./migrations.js";
import type { ControlPlaneDatabase, ControlPlaneQuery } from "./project-scope.js";

export class PostgresControlPlaneDatabase implements ControlPlaneDatabase {
  constructor(private readonly pool: Pool) {
    pool.on("error", () => {
      logEvent("warn", "control_plane.postgres.idle_connection_discarded");
    });
  }

  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<{ rows: Row[] }> {
    const result = await this.pool.query(statement, [...parameters]);
    return { rows: result.rows as Row[] };
  }

  async connect(): Promise<ControlPlaneMigrationClient> {
    const client = await this.pool.connect();
    return {
      query: async <Row>(statement: string, parameters: readonly unknown[] = []) => {
        const result = await client.query(statement, [...parameters]);
        return { rows: result.rows as Row[] };
      },
      release: (error?: Error | true) => client.release(error),
    };
  }

  async transaction<Result>(
    operation: (transaction: ControlPlaneQuery) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    let began = false;
    let releaseError: Error | true | undefined;
    try {
      await client.query("BEGIN");
      began = true;
      const transaction: ControlPlaneQuery = {
        query: async <Row>(statement: string, parameters: readonly unknown[]) => {
          const result = await client.query(statement, [...parameters]);
          return { rows: result.rows as Row[] };
        },
      };
      const result = await operation(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : true;
          throw new AggregateError(
            [error, rollbackError],
            "The control-plane transaction and rollback both failed.",
          );
        }
      }
      throw error;
    } finally {
      if (releaseError === undefined) {
        client.release();
      } else {
        client.release(releaseError);
      }
    }
  }

  async assertReady(): Promise<void> {
    await this.query("SELECT 1", []);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
