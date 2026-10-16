const pgClients: any[] = [];
const pgConnectErrors: Array<Error | null> = [];

jest.mock("pg", () => {
    class Client {
        config: any;
        queries: any[] = [];
        ended = false;
        constructor(config: any) {
            this.config = config;
            pgClients.push(this);
        }
        async connect() {
            const error = pgConnectErrors.shift();
            if (error) {
                throw error;
            }
        }
        async query(query: any) {
            this.queries.push(query);
            const text = typeof query === "string" ? query : query.text;
            if (/^(BEGIN|ROLLBACK|SET)/.test(text)) {
                return { command: text.split(" ")[0], rows: [], fields: [] };
            }
            return { command: "SELECT", rows: [{ ok: 1 }], fields: [{ name: "ok" }] };
        }
        async end() {
            this.ended = true;
        }
    }
    return { __esModule: true, default: { Client, types: { getTypeParser: () => (v: string) => v } } };
});

const mysqlConnections: any[] = [];

jest.mock("mysql2/promise", () => ({
    __esModule: true,
    default: {
        createConnection: async (config: any) => {
            const connection = {
                config,
                queries: [] as any[],
                ended: false,
                async query(query: any, params?: unknown[]) {
                    connection.queries.push({ query, params });
                    const sql = typeof query === "string" ? query : query.sql;
                    if (!/^SELECT/.test(sql)) {
                        return [{ affectedRows: 0 }, undefined];
                    }
                    return [[{ ok: 1 }], []];
                },
                async end() {
                    connection.ended = true;
                },
                destroy() {},
            };
            mysqlConnections.push(connection);
            return connection;
        },
    },
}));

import { runSession, SessionOptions } from "../../src/clients/db-session";
import { pgTypeParser } from "../../src/clients/postgres-session";
import { ConnectionConfig } from "../../src/utils/config";
import { createManager, PROD_CONFIG, TESTING_ALPHA, TESTING_CONFIG } from "../helpers/configs";

const pgConn: ConnectionConfig = {
    host: "pgsql-example-repl.example.test",
    port: 5432,
    database: "crm",
    user: "ro",
    password: "pw",
    block_store: null,
    db_type: "postgres",
};
const mysqlConn: ConnectionConfig = { ...pgConn, host: "mysql-example-repl.example.test", port: 3306, db_type: "mysql" };

const prodOptions: SessionOptions = { readOnly: true, connectTimeoutSec: 2, queryTimeoutSec: 30 };
const testingOptions: SessionOptions = { readOnly: false, connectTimeoutSec: 2, queryTimeoutSec: 30 };

const sqlOf = (query: any) => (typeof query === "string" ? query : query.text ?? query.sql);

beforeEach(() => {
    pgClients.length = 0;
    pgConnectErrors.length = 0;
    mysqlConnections.length = 0;
});

describe("postgres session", () => {
    it("wraps a prod session in BEGIN READ ONLY … ROLLBACK, one statement per query", async () => {
        const result = await runSession(pgConn, prodOptions, (s) => s.query("SELECT 1 AS ok"));

        expect(result).toEqual({ rows: [{ ok: 1 }], hasResultSet: true });
        const client = pgClients[0];
        expect(client.queries.map(sqlOf)).toEqual([
            "BEGIN READ ONLY",
            "SET LOCAL statement_timeout = 30000",
            "SELECT 1 AS ok",
            "ROLLBACK",
        ]);
        expect(client.queries[2]).toMatchObject({ queryMode: "extended", values: [] });
        expect(client.ended).toBe(true);
    });

    it("does not commit when the prod query fails", async () => {
        await expect(
            runSession(pgConn, prodOptions, async () => {
                throw new Error("cannot execute DELETE in a read-only transaction");
            }),
        ).rejects.toThrow("read-only transaction");
        const statements = pgClients[0].queries.map(sqlOf);
        expect(statements).not.toContain("COMMIT");
        expect(pgClients[0].ended).toBe(true);
    });

    it("runs a testing session without a transaction wrapper", async () => {
        await runSession(pgConn, testingOptions, (s) => s.query("UPDATE t SET x = 1"));
        expect(pgClients[0].queries.map(sqlOf)).toEqual(["SET statement_timeout = 30000", "UPDATE t SET x = 1"]);
        expect(typeof pgClients[0].queries[1]).toBe("string");
    });

    it("skips the statement timeout at 0", async () => {
        await runSession(pgConn, { ...prodOptions, queryTimeoutSec: 0 }, (s) => s.query("SELECT 1"));
        expect(pgClients[0].queries.map(sqlOf)).toEqual(["BEGIN READ ONLY", "SELECT 1", "ROLLBACK"]);
    });

    it("tries TLS first and falls back to plain TCP like sslmode=prefer", async () => {
        pgConnectErrors.push(new Error("The server does not support SSL connections"));
        await runSession(pgConn, prodOptions, (s) => s.query("SELECT 1"));
        expect(pgClients).toHaveLength(2);
        expect(pgClients[0].config.ssl).toEqual({ rejectUnauthorized: false });
        expect(pgClients[1].config.ssl).toBeUndefined();
        expect(pgClients[1].config.connectionTimeoutMillis).toBe(2000);
        expect(pgClients[1].queries.map(sqlOf)[0]).toBe("BEGIN READ ONLY");
    });

    it("does not retry a network timeout", async () => {
        pgConnectErrors.push(new Error("timeout expired"));
        await expect(runSession(pgConn, prodOptions, (s) => s.query("SELECT 1"))).rejects.toThrow("timeout expired");
        expect(pgClients).toHaveLength(1);
    });

    it("keeps safe int8 as a number and timestamps as server text", () => {
        expect(pgTypeParser(20)("42")).toBe(42);
        expect(pgTypeParser(20)("9223372036854775807")).toBe("9223372036854775807");
        expect(pgTypeParser(1184)("2026-10-16 08:00:00+00")).toBe("2026-10-16 08:00:00+00");
    });
});

describe("mysql session", () => {
    it("wraps a prod session in START TRANSACTION READ ONLY … ROLLBACK", async () => {
        const result = await runSession(mysqlConn, prodOptions, (s) => s.query("SELECT 1 AS ok"));

        expect(result).toEqual({ rows: [{ ok: 1 }], hasResultSet: true });
        const connection = mysqlConnections[0];
        expect(connection.queries.map((q: any) => sqlOf(q.query))).toEqual([
            "SET SESSION MAX_EXECUTION_TIME = 30000",
            "START TRANSACTION READ ONLY",
            "SELECT 1 AS ok",
            "ROLLBACK",
        ]);
        expect(connection.queries[2].query.timeout).toBe(30000);
        expect(connection.config).toMatchObject({ multipleStatements: false, connectTimeout: 2000 });
        expect(connection.ended).toBe(true);
    });

    it("commits a testing session without a read-only transaction", async () => {
        const result = await runSession(mysqlConn, testingOptions, (s) => s.query("UPDATE t SET x = 1"));
        expect(result).toEqual({ rows: [], hasResultSet: false });
        expect(mysqlConnections[0].queries.map((q: any) => sqlOf(q.query))).toEqual([
            "SET SESSION MAX_EXECUTION_TIME = 30000",
            "UPDATE t SET x = 1",
            "COMMIT",
        ]);
    });
});

describe("DatabaseManager with the real drivers (mocked)", () => {
    it("sends a prod execute_query through a read-only postgres transaction", async () => {
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG);

        const result = await manager.executeQuery("SELECT 1 AS ok", "prod_db");

        expect(result.success).toBe(true);
        expect(result.data).toEqual([{ ok: 1 }]);
        expect(pgClients[0].queries.map(sqlOf)).toEqual([
            "BEGIN READ ONLY",
            "SET LOCAL statement_timeout = 30000",
            "SELECT 1 AS ok",
            "ROLLBACK",
        ]);
    });

    it("does not wrap a testing execute_query", async () => {
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG);
        await manager.executeQuery("DELETE FROM t", "crm", TESTING_ALPHA);
        expect(pgClients[0].queries.map(sqlOf)).toEqual(["SET statement_timeout = 30000", "DELETE FROM t"]);
    });

    it("reads prod metadata in a read-only transaction too", async () => {
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG);
        await manager.getDatabaseInfo("prod_db");
        const statements = pgClients[0].queries.map(sqlOf);
        expect(statements[0]).toBe("BEGIN READ ONLY");
        expect(statements[statements.length - 1]).toBe("ROLLBACK");
    });
});
