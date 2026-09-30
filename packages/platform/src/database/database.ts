import { recordRecovery } from "../logger/recovery.js";
import pg from "pg";
import type { DatabaseConfig } from "../config/schemas.js";
import type { Logger } from "../logger/create-logger.js";

export interface Queryable {
  query<Row extends object>(sql: string, values?: readonly unknown[]): Promise<Row[]>;
}

/** The only door to Postgres. Repositories take a `Database`, or the `Queryable` of a transaction. */
export interface Database extends Queryable {
  transaction<Result>(work: (transaction: Queryable) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}

interface ClientLike {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: object[] }>;
  release(): void;
}

/** The parts of `pg.Pool` the database uses, so tests can pass a fake. */
export interface PoolLike {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: object[] }>;
  connect(): Promise<ClientLike>;
  end(): Promise<void>;
}

export class PostgresDatabase implements Database {
  constructor(private readonly pool: PoolLike) {}

  async query<Row extends object>(sql: string, values: readonly unknown[] = []): Promise<Row[]> {
    const result = await this.pool.query(sql, values);
    return result.rows as Row[];
  }

  async transaction<Result>(work: (transaction: Queryable) => Promise<Result>): Promise<Result> {
    const client = await this.pool.connect();
    const transaction: Queryable = {
      query: async <Row extends object>(sql: string, values: readonly unknown[] = []) =>
        (await client.query(sql, values)).rows as Row[],
    };
    try {
      await client.query("BEGIN");
      const result = await work(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => {
        recordRecovery(rollbackError, { operation: "database.rollback", originalError: error });
      });
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export function createDatabase(config: DatabaseConfig, log: Logger): Database {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxConnections,
    statement_timeout: config.statementTimeoutMs,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", (error) => log.error({ err: error }, "idle database connection failed"));
  return new PostgresDatabase(pool);
}
