import { ConnectionConfig } from "../utils/config.js";
import { withMysqlSession } from "./mysql-session.js";
import { withPostgresSession } from "./postgres-session.js";

export type Row = Record<string, unknown>;

export interface QueryResult {
    rows: Row[];
    /** False for statements without a result set (INSERT without RETURNING, SET …). */
    hasResultSet: boolean;
}

export interface DbSession {
    query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

export interface SessionOptions {
    /**
     * Prod: the whole session runs in a database-enforced read-only transaction
     * (`BEGIN READ ONLY` / `START TRANSACTION READ ONLY`, then ROLLBACK), one statement per query.
     */
    readOnly: boolean;
    connectTimeoutSec: number;
    /** 0 = no limit. */
    queryTimeoutSec: number;
}

export type SessionRunner = <T>(
    conn: ConnectionConfig,
    options: SessionOptions,
    work: (session: DbSession) => Promise<T>,
) => Promise<T>;

export const runSession: SessionRunner = (conn, options, work) =>
    conn.db_type === "mysql" ? withMysqlSession(conn, options, work) : withPostgresSession(conn, options, work);
