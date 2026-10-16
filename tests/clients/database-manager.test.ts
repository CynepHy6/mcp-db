import { DbSession, QueryResult, SessionOptions, SessionRunner } from "../../src/clients/db-session";
import { ConnectionConfig } from "../../src/utils/config";
import {
    createManager,
    PROD_CONFIG,
    TESTING_ALPHA,
    TESTING_CONFIG,
    TESTING_CONFIG_WITH_STAGING,
} from "../helpers/configs";

interface SessionCall {
    conn: ConnectionConfig;
    options: SessionOptions;
    queries: Array<{ sql: string; params?: unknown[] }>;
}

/** Fake runner: records every session and answers queries through `respond`. */
const fakeRunner = (respond: (sql: string, conn: ConnectionConfig) => QueryResult = () => ({ rows: [], hasResultSet: true })) => {
    const calls: SessionCall[] = [];
    const runner: SessionRunner = async (conn, options, work) => {
        const call: SessionCall = { conn, options, queries: [] };
        calls.push(call);
        const session: DbSession = {
            async query(sql, params) {
                call.queries.push({ sql, params });
                return respond(sql, conn);
            },
        };
        return work(session);
    };
    return { runner, calls };
};

describe("executeQuery", () => {
    it("runs prod queries in a read-only session", async () => {
        const { runner, calls } = fakeRunner(() => ({ rows: [{ ok: 1 }], hasResultSet: true }));
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });

        const result = await manager.executeQuery("SELECT 1 AS ok", "prod_db");

        expect(result).toMatchObject({
            success: true,
            data: [{ ok: 1 }],
            rows_count: 1,
            timeout_sec: 30,
            service: "prod_db",
            testing: null,
            database: "prod_db",
            db_type: "postgres",
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].options).toEqual({ readOnly: true, connectTimeoutSec: 2, queryTimeoutSec: 30 });
    });

    it("rejects a data-modifying CTE on prod before connecting", async () => {
        const { runner, calls } = fakeRunner();
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });

        await expect(
            manager.executeQuery("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "prod_db"),
        ).rejects.toThrow("Запрос содержит недопустимые операции");
        expect(calls).toHaveLength(0);
    });

    it("runs testing queries in a writable session and returns the dialect hint", async () => {
        const { runner, calls } = fakeRunner(() => ({ rows: [], hasResultSet: false }));
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });

        const result = await manager.executeQuery("UPDATE crm SET x = 1", "crm", TESTING_ALPHA);

        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
        expect(result.db_type).toBe("postgres");
        expect(result.sql_dialect_hint).toContain("PostgreSQL");
        expect(result.engine).toBe("pg15");
        expect(result.testing).toBe(TESTING_ALPHA);
        expect(result).not.toHaveProperty("caution");
        expect(calls[0].options.readOnly).toBe(false);
        expect(calls[0].conn.host).toBe("test-alpha-local.example.test");
    });

    it("passes the per-call timeout to the session", async () => {
        const { runner, calls } = fakeRunner();
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });

        const result = await manager.executeQuery("SELECT 1", "crm", TESTING_ALPHA, 60);

        expect(result.success).toBe(true);
        expect(result.timeout_sec).toBe(60);
        expect(calls[0].options.queryTimeoutSec).toBe(60);
    });

    it("returns an error for a negative timeout", async () => {
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: fakeRunner().runner });
        const result = await manager.executeQuery("SELECT 1", "crm", TESTING_ALPHA, -5);
        expect(result.success).toBe(false);
        expect(result.error).toContain("отрицательным");
    });

    it("explains a timeout error", async () => {
        const runner: SessionRunner = async () => {
            throw new Error("canceling statement due to statement timeout");
        };
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });

        const result = await manager.executeQuery("SELECT pg_sleep(100)", "crm", TESTING_ALPHA, 5);

        expect(result.success).toBe(false);
        expect(result.error).toContain("превысил лимит 5с");
        expect(result.error).toContain("canceling statement");
        expect(result.db_type).toBe("postgres");
    });

    it("reports an unknown prod database", async () => {
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: fakeRunner().runner });
        const result = await manager.executeQuery("SELECT 1", "nope");
        expect(result).toMatchObject({ success: false, error: "БД nope не найдена в конфигурации", timeout_sec: 30 });
    });

    it("adds caution for a write on staging only", async () => {
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG_WITH_STAGING, { runSession: fakeRunner().runner });

        const write = await manager.executeQuery("UPDATE crm SET x = 1", "crm", "s2");
        expect(write.caution).toContain("не рекомендуется");

        const read = await manager.executeQuery("SELECT 1", "crm", "s2");
        expect(read).not.toHaveProperty("caution");
    });

    it("uses TESTING_NAME when testing is omitted, explicit testing wins", async () => {
        process.env.TESTING_NAME = "y12";
        const { runner, calls } = fakeRunner();
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });

        const implicit = await manager.executeQuery("DELETE FROM t", "trm");
        expect(implicit.testing).toBe("test-y12");
        expect(calls[0].conn.host).toBe("test-y12-local.example.test");
        expect(calls[0].options.readOnly).toBe(false);

        await manager.executeQuery("SELECT 1", "trm", "test-y99");
        expect(calls[1].conn.host).toBe("test-y99-local.example.test");
    });

    it("testing=prod reaches prod in a read-only session even with TESTING_NAME", async () => {
        process.env.TESTING_NAME = "y12";
        const { runner, calls } = fakeRunner(() => ({ rows: [{ ok: 1 }], hasResultSet: true }));
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });

        const result = await manager.executeQuery("SELECT 1 AS ok", "prod_db", "prod");
        expect(result).toMatchObject({ success: true, testing: null, database: "prod_db" });
        expect(calls[0].options.readOnly).toBe(true);
        expect(calls[0].conn.host).not.toContain("test-y12");

        const info = await manager.getDatabaseInfo("prod_db", "prod");
        expect(info).toMatchObject({ testing: null });
        expect(calls[1].options.readOnly).toBe(true);
    });
});

describe("testing-only mode", () => {
    beforeEach(() => {
        process.env.MCP_DB_TESTING_ONLY = "1";
    });

    it("does not open prod without a stand", async () => {
        const manager = createManager("{}", TESTING_CONFIG, { runSession: fakeRunner().runner });

        const result = await manager.executeQuery("SELECT 1", "trm");
        expect(result.success).toBe(false);
        expect(result.error).toContain("TESTING_NAME");

        await expect(manager.listDatabases()).rejects.toThrow("TESTING_NAME");
    });

    it("lists the catalog without probing", async () => {
        process.env.TESTING_NAME = "test-y12";
        const { runner, calls } = fakeRunner();
        const manager = createManager("{}", TESTING_CONFIG, { runSession: runner });

        const listed = await manager.listDatabases();

        expect(listed["trm@test-y12"]).toMatchObject({
            available: null,
            probed: false,
            connection_config: { host: "test-y12-local.example.test", database: "trm_auto_y12" },
        });
        expect(listed["skysmart_english@test-y12"].block_store_database).toBe("vimbox_store_english_skysmart");
        expect(calls).toHaveLength(0);
    });
});

describe("listDatabases", () => {
    it("probes prod in read-only sessions", async () => {
        const { runner, calls } = fakeRunner((sql) => {
            if (sql.includes("current_database()")) {
                return { rows: [{ database_name: "prod_db", size_bytes: 10 }], hasResultSet: true };
            }
            return { rows: [{ tables_count: 3 }], hasResultSet: true };
        });
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });

        const listed = await manager.listDatabases();

        expect(listed.prod_db).toMatchObject({ database_name: "prod_db", size_bytes: 10, tables_count: 3, available: true });
        expect(calls.every((call) => call.options.readOnly)).toBe(true);
    });

    it("reports an unavailable database instead of failing the list", async () => {
        const runner: SessionRunner = async () => {
            throw new Error("connection refused");
        };
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });
        const listed = await manager.listDatabases();
        expect(listed.prod_db).toMatchObject({ available: false, error: "connection refused" });
    });

    it("caches within the TTL and refetches after it", async () => {
        let now = 1000;
        const { runner, calls } = fakeRunner(() => ({ rows: [{}], hasResultSet: true }));
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner, now: () => now });
        manager.listDatabasesTtlMs = 10_000;

        expect(manager.listDatabasesCache.size).toBe(0);
        await manager.listDatabases();
        const sessionsAfterFirst = calls.length;
        await manager.listDatabases();
        expect(calls.length).toBe(sessionsAfterFirst);
        expect(manager.listDatabasesCache.has("prod:probe")).toBe(true);

        now += 11_000;
        await manager.listDatabases();
        expect(calls.length).toBe(sessionsAfterFirst * 2);
    });

    it("keeps separate cache keys for prod and each stand", async () => {
        const { runner, calls } = fakeRunner(() => ({ rows: [{}], hasResultSet: true }));
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });

        await manager.listDatabases();
        await manager.listDatabases(TESTING_ALPHA);
        await manager.listDatabases();
        await manager.listDatabases(TESTING_ALPHA);

        expect([...manager.listDatabasesCache.keys()]).toEqual(["prod:probe", `testing:${TESTING_ALPHA}:probe`]);
        // 1 prod database + 4 testing services, each probed once.
        expect(new Set(calls.map((call) => call.conn.testing ?? "prod")).size).toBe(2);
        expect(calls).toHaveLength(5);
    });

    it("returns a copy, not the cached object", async () => {
        process.env.MCP_DB_LIST_PROBE = "0";
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: fakeRunner().runner });
        const first = await manager.listDatabases();
        first.prod_db.available = "mutated";
        const second = await manager.listDatabases();
        expect(second.prod_db.available).toBeNull();
    });

    it("limits the probe fan-out with MCP_DB_LIST_MAX_WORKERS", async () => {
        process.env.MCP_DB_LIST_MAX_WORKERS = "1";
        let active = 0;
        let maxActive = 0;
        const runner: SessionRunner = async (_conn, _options, work) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            try {
                return await work({ query: async () => ({ rows: [{}], hasResultSet: true }) });
            } finally {
                active -= 1;
            }
        };
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });
        const listed = await manager.listDatabases(TESTING_ALPHA);
        expect(Object.keys(listed)).toEqual([
            `crm@${TESTING_ALPHA}`,
            `trm@${TESTING_ALPHA}`,
            `timetable@${TESTING_ALPHA}`,
            `skysmart_english@${TESTING_ALPHA}`,
        ]);
        expect(maxActive).toBe(1);
    });
});

describe("getDatabaseInfo and getTablesSchemas", () => {
    it("collects info and tables in a read-only session on prod", async () => {
        const { runner, calls } = fakeRunner((sql) => {
            if (sql.includes("current_database()")) {
                return { rows: [{ database_name: "prod_db" }], hasResultSet: true };
            }
            if (sql.includes("pg_tables")) {
                return { rows: [{ tablename: "users", size: "8 kB" }], hasResultSet: true };
            }
            return { rows: [{ tables_count: 1 }], hasResultSet: true };
        });
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });

        const info = await manager.getDatabaseInfo("prod_db");

        expect(info).toMatchObject({
            success: true,
            database: "prod_db",
            info: { database_name: "prod_db" },
            tables: [{ tablename: "users", size: "8 kB" }],
            tables_count: 1,
            connection_config: { db_type: "postgres", testing: null, service: null },
        });
        expect(calls[0].options.readOnly).toBe(true);
    });

    it("groups columns and indexes, with dialect placeholders", async () => {
        const { runner, calls } = fakeRunner((sql) => {
            if (sql.includes("information_schema.columns")) {
                return {
                    rows: [
                        { table_name: "lessons", column_name: "id", data_type: "int", is_nullable: "NO", column_default: null },
                    ],
                    hasResultSet: true,
                };
            }
            return { rows: [{ tablename: "lessons", indexname: "PRIMARY", indexdef: "INDEX PRIMARY (id)" }], hasResultSet: true };
        });
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });

        const result = await manager.getTablesSchemas("timetable", TESTING_ALPHA, ["lessons", "slots"]);

        expect(result).toMatchObject({
            success: true,
            database: "timetable",
            tables_count: 1,
            requested_tables: ["lessons", "slots"],
            tables: {
                lessons: {
                    columns: [{ column_name: "id", character_maximum_length: null }],
                    indexes: [{ indexname: "PRIMARY" }],
                },
            },
        });
        expect(calls[0].queries[0].sql).toContain("table_name IN (?,?)");
        expect(calls[0].queries[0].params).toEqual(["lessons", "slots"]);
        expect(calls[0].queries[1].sql).toContain("table_name IN (?,?)");
    });

    it("uses $n placeholders for postgres", async () => {
        const { runner, calls } = fakeRunner();
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: runner });
        await manager.getTablesSchemas("crm", TESTING_ALPHA, ["a", "b"]);
        expect(calls[0].queries[0].sql).toContain("table_name IN ($1,$2)");
        expect(calls[0].queries[1].sql).toContain("tablename IN ($1,$2)");
    });

    it("returns the resolve error without requested_tables", async () => {
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG, { runSession: fakeRunner().runner });
        const result = await manager.getTablesSchemas("nope");
        expect(result).toEqual({ success: false, error: "БД nope не найдена в конфигурации", service: "nope", testing: null });
    });
});
