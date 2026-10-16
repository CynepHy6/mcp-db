import mysql from "mysql2/promise";
import type { ConnectionConfig } from "../utils/config.js";
import type { DbSession, Row, SessionOptions } from "./db-session.js";

/** Errors after which a plain TCP retry makes sense: no TLS on the server, or auth bound to the transport. */
const PLAIN_RETRY_CODES = new Set(["HANDSHAKE_NO_SSL_SUPPORT", "HANDSHAKE_SSL_ERROR", "ER_ACCESS_DENIED_ERROR"]);

const plainRetryAllowed = (error: unknown): boolean => {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && PLAIN_RETRY_CODES.has(code);
};

/**
 * Like sslmode=prefer for Postgres: TLS without certificate checks first, plain TCP if the server
 * has no TLS or refuses the login over it. Replica accounts that require TLS are denied over plain TCP.
 */
const connect = async (config: mysql.ConnectionOptions): Promise<mysql.Connection> => {
    try {
        return await mysql.createConnection({ ...config, ssl: { rejectUnauthorized: false } });
    } catch (error) {
        if (!plainRetryAllowed(error)) {
            throw error;
        }
        try {
            return await mysql.createConnection(config);
        } catch {
            throw error;
        }
    }
};

export const withMysqlSession = async <T>(
    conn: ConnectionConfig,
    options: SessionOptions,
    work: (session: DbSession) => Promise<T>,
): Promise<T> => {
    const connection = await connect({
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
        database: conn.database,
        ...(options.connectTimeoutSec > 0 ? { connectTimeout: options.connectTimeoutSec * 1000 } : {}),
        // One statement per query: `COMMIT; …` cannot leave the read-only transaction.
        multipleStatements: false,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: false,
    });

    const timeoutMs = options.queryTimeoutSec > 0 ? Math.trunc(options.queryTimeoutSec) * 1000 : 0;

    try {
        if (timeoutMs > 0) {
            // SELECT only; the client-side timeout below covers the rest.
            await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${timeoutMs}`);
        }
        if (options.readOnly) {
            await connection.query("START TRANSACTION READ ONLY");
        }

        const session: DbSession = {
            async query(sql, params) {
                const [rows] = await connection.query(
                    { sql, ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}) },
                    params ?? [],
                );
                const hasResultSet = Array.isArray(rows);
                return { rows: hasResultSet ? (rows as Row[]) : [], hasResultSet };
            },
        };

        const value = await work(session);
        await connection.query(options.readOnly ? "ROLLBACK" : "COMMIT");
        return value;
    } finally {
        await connection.end().catch(() => connection.destroy());
    }
};
