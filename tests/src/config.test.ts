import { inferDbType } from "../../src/utils/config";
import { normalizeQueryTimeoutSec, listProbeEnabled, testingOnly } from "../../src/utils/env";
import { connectionSummaryQueries, sqlDialectHint } from "../../src/utils/sql";
import { isStagingEnv, normalizeTestingEnv, coerceTesting } from "../../src/utils/testing-env";
import {
    createManager,
    LEGACY_HOST,
    MYSQL_REPL_HOST,
    PGSQL_REPL_HOST,
    PROD_CONFIG,
    TEST_ENV_HOST,
    TESTING_ALPHA,
    TESTING_BETA,
    TESTING_CONFIG,
    TESTING_CONFIG_WITH_STAGING,
    writeConfigs,
} from "../helpers/configs";
import { DatabaseManager } from "../../src/clients/database-manager";

describe("prod config", () => {
    it("supports the legacy host:port / user:password format", () => {
        const manager = createManager(
            `legacy_db:\n  ${LEGACY_HOST}: 5432\n  legacy_user: secret\n  block_store: legacy_block_store`,
        );
        expect(manager.connections.legacy_db).toEqual({
            host: LEGACY_HOST,
            port: 5432,
            database: "legacy_db",
            user: "legacy_user",
            password: "secret",
            block_store: "legacy_block_store",
            db_type: "postgres",
        });
    });

    it("supports explicit keys with type and database override", () => {
        const manager = createManager(
            "tt:\n  host: db.example.test\n  port: 3307\n  user: ro\n  password: pw\n  type: mysql\n  database: timetable",
        );
        expect(manager.connections.tt).toMatchObject({
            host: "db.example.test",
            port: 3307,
            database: "timetable",
            db_type: "mysql",
            block_store: null,
        });
    });

    it("skips an incomplete entry", () => {
        const manager = createManager("broken:\n  host: db.example.test\n");
        expect(manager.connections).toEqual({});
    });

    it("accepts an empty object (testing-only setups)", () => {
        expect(createManager("{}").connections).toEqual({});
    });

    it("rejects the _testing section", () => {
        expect(() =>
            createManager(
                "_testing:\n  user: u\n  password: p\n  host_template: '{{env}}-x.test'\n  engines:\n    pg11: { port: 15432, type: postgres }\n  services:\n    crm: pg11",
                null,
            ),
        ).toThrow("отдельный файл .db-testing.yaml");
    });

    it("throws when the prod file is missing", () => {
        const paths = writeConfigs(null, TESTING_CONFIG);
        expect(() => new DatabaseManager(paths)).toThrow("не найден");
    });

    it("throws when the prod file is not a mapping", () => {
        expect(() => createManager("- a\n- b")).toThrow("должна быть объектом");
    });

    it("detects db_type from the replica host prefix", () => {
        const manager = createManager(
            `timetable:\n  ${MYSQL_REPL_HOST}: 3306\n  ro_user: secret\n\n` +
                `student_vacation:\n  ${PGSQL_REPL_HOST}: 5432\n  ro_user: secret`,
        );
        expect(manager.connections.timetable.db_type).toBe("mysql");
        expect(manager.connections.student_vacation.db_type).toBe("postgres");
    });

    it.each([
        [MYSQL_REPL_HOST, 3306, "mysql"],
        [PGSQL_REPL_HOST, 5432, "postgres"],
        [LEGACY_HOST, 5432, "postgres"],
        [TEST_ENV_HOST, 3306, "mysql"],
        [TEST_ENV_HOST, 5432, "postgres"],
        [TEST_ENV_HOST, 25432, "postgres"],
    ])("inferDbType(%s, %d) = %s", (host, port, expected) => {
        expect(inferDbType(host, port)).toBe(expected);
    });
});

describe("testing config", () => {
    it("is optional", () => {
        const manager = createManager(PROD_CONFIG, null);
        expect(manager.testingConfig).toBeNull();
        expect(() => manager.resolveTestingConnection(TESTING_ALPHA, "crm")).toThrow(".db-testing.yaml не настроен");
    });

    it("builds host and database for a service", () => {
        const manager = createManager();
        expect(manager.resolveTestingConnection(TESTING_ALPHA, "crm")).toEqual({
            host: "test-alpha-local.example.test",
            port: 25432,
            database: "crm_auto_alpha",
            user: "test_user",
            password: "secret",
            block_store: null,
            db_type: "postgres",
            engine: "pg15",
            testing: TESTING_ALPHA,
            service: "crm",
        });
    });

    it("strips test- for the database suffix", () => {
        const conn = createManager().resolveTestingConnection(TESTING_BETA, "trm");
        expect(conn.host).toBe("test-beta-local.example.test");
        expect(conn.database).toBe("trm_auto_beta");
    });

    it("supports a database override and the mysql engine", () => {
        const conn = createManager().resolveTestingConnection(TESTING_ALPHA, "timetable");
        expect(conn.database).toBe("timetable");
        expect(conn.db_type).toBe("mysql");
    });

    it("carries block_store", () => {
        const conn = createManager().resolveTestingConnection(TESTING_ALPHA, "skysmart_english");
        expect(conn.block_store).toBe("vimbox_store_english_skysmart");
    });

    it("names an unknown service", () => {
        expect(() => createManager().resolveTestingConnection(TESTING_ALPHA, "unknown_service")).toThrow(
            "unknown_service",
        );
    });

    const brokenTesting = (body: string) => createManager(PROD_CONFIG, body);

    it("requires the placeholder in host_template", () => {
        const manager = brokenTesting(
            'user: u\npassword: p\nhost_template: "fixed-host.example.test"\nengines:\n  pg11: { port: 15432, type: postgres }\nservices:\n  crm: pg11',
        );
        expect(manager.testingConfig).toBeNull();
        expect(manager.testingConfigError).toContain("host_template должен содержать");
    });

    it("requires the placeholder in staging_host_template", () => {
        const manager = brokenTesting(
            'user: u\npassword: p\nhost_template: "{{env}}-local.example.test"\nstaging_host_template: "fixed.example.test"\nengines:\n  pg11: { port: 15432, type: postgres }\nservices:\n  crm: pg11',
        );
        expect(manager.testingConfigError).toContain("staging_host_template должен содержать");
    });

    it("reports a missing engine port per call", async () => {
        const manager = brokenTesting(
            'user: u\npassword: p\nhost_template: "{{env}}-local.example.test"\nengines:\n  pg11: { type: postgres }\nservices:\n  crm: pg11',
        );
        expect(manager.testingConfig).toBeNull();
        expect(manager.testingConfigError).toContain("не указан port");
        expect(manager.testingConfigError).toContain("pg11");

        const result = await manager.executeQuery("SELECT 1", "crm", TESTING_ALPHA);
        expect(result.success).toBe(false);
        expect(result.error).toContain("не указан port");
    });

    it("reports a missing engine type per call", async () => {
        const manager = brokenTesting(
            'user: u\npassword: p\nhost_template: "{{env}}-local.example.test"\nengines:\n  pg11: { port: 15432 }\nservices:\n  crm: pg11',
        );
        expect(manager.testingConfigError).toContain("не указан type");
        const result = await manager.executeQuery("SELECT 1", "crm", TESTING_ALPHA);
        expect(result.error).toContain("не указан type");
    });

    it("rejects an unknown engine type", () => {
        const manager = brokenTesting(
            'user: u\npassword: p\nhost_template: "{{env}}-local.example.test"\nengines:\n  ms: { port: 1, type: mssql }\nservices:\n  crm: ms',
        );
        expect(manager.testingConfigError).toContain("'mssql' (ожидается mysql или postgres)");
    });

    it("rejects a service on an unknown engine", () => {
        const manager = brokenTesting(
            'user: u\npassword: p\nhost_template: "{{env}}-local.example.test"\nengines:\n  pg11: { port: 15432, type: postgres }\nservices:\n  crm: pg99',
        );
        expect(manager.testingConfigError).toContain("неизвестный engine");
    });

    it("rejects a missing required field", () => {
        const manager = brokenTesting('user: u\nhost_template: "{{env}}"\nengines: {}\nservices: {}');
        expect(manager.testingConfigError).toContain("обязательное поле password");
    });
});

describe("stand names", () => {
    it.each([
        ["s2", true],
        ["s16", true],
        ["test-alpha", false],
        ["test-y10", false],
        ["y10", false],
        ["my-env", false],
        ["staging", false],
    ])("isStagingEnv(%s) = %s", (testing, expected) => {
        expect(isStagingEnv(testing)).toBe(expected);
    });

    it.each([
        ["y10", "test-y10"],
        ["y148", "test-y148"],
        ["test-y10", "test-y10"],
        ["test-alpha", "test-alpha"],
        ["my-env", "my-env"],
        ["s2", "s2"],
    ])("normalizeTestingEnv(%s) = %s", (testing, expected) => {
        expect(normalizeTestingEnv(testing)).toBe(expected);
    });

    it("maps the qa-panel short name in host and database", () => {
        const manager = createManager();
        expect(manager.resolveTestingHost("y10")).toBe("test-y10-local.example.test");
        expect(manager.resolveTestingHost("test-y10")).toBe("test-y10-local.example.test");

        const conn = manager.resolveTestingConnection("y10", "crm");
        expect(conn.testing).toBe("test-y10");
        expect(conn.database).toBe("crm_auto_y10");

        const [key, resolved] = manager.resolveTarget("crm", "y10");
        expect(key).toBe("crm@test-y10");
        expect(resolved.testing).toBe("test-y10");
    });

    it("uses staging_host_template for sN", () => {
        const manager = createManager(PROD_CONFIG, TESTING_CONFIG_WITH_STAGING);
        expect(manager.resolveTestingHost("s2")).toBe("yc-staging-s2-db.example.test");
        expect(manager.resolveTestingHost(TESTING_ALPHA)).toBe("test-alpha-local.example.test");
    });

    it("falls back to host_template for sN without staging_host_template", () => {
        expect(createManager().resolveTestingHost("s2")).toBe("s2-local.example.test");
    });

    it("coerceTesting: explicit wins, then TESTING_NAME, empty string is unset", () => {
        expect(coerceTesting(undefined)).toBeNull();
        process.env.TESTING_NAME = " y12 ";
        expect(coerceTesting(undefined)).toBe("test-y12");
        expect(coerceTesting("")).toBe("test-y12");
        expect(coerceTesting("test-y99")).toBe("test-y99");
    });
});

describe("env", () => {
    it("normalizes the query timeout", () => {
        expect(normalizeQueryTimeoutSec(undefined)).toBe(30);
        expect(normalizeQueryTimeoutSec(120)).toBe(120);
        expect(normalizeQueryTimeoutSec(0)).toBe(0);
        expect(normalizeQueryTimeoutSec("45")).toBe(45);
        expect(() => normalizeQueryTimeoutSec(-1)).toThrow("отрицательным");
        expect(() => normalizeQueryTimeoutSec("slow")).toThrow("целым числом");
    });

    it("takes the default timeout from MCP_DB_QUERY_TIMEOUT", () => {
        process.env.MCP_DB_QUERY_TIMEOUT = "90";
        expect(normalizeQueryTimeoutSec(undefined)).toBe(90);
        process.env.MCP_DB_QUERY_TIMEOUT = "nope";
        expect(normalizeQueryTimeoutSec(undefined)).toBe(30);
    });

    it("probes by default unless testing-only; explicit MCP_DB_LIST_PROBE wins", () => {
        expect(listProbeEnabled()).toBe(true);
        process.env.MCP_DB_TESTING_ONLY = "1";
        expect(testingOnly()).toBe(true);
        expect(listProbeEnabled()).toBe(false);
        process.env.MCP_DB_LIST_PROBE = "yes";
        expect(listProbeEnabled()).toBe(true);
        delete process.env.MCP_DB_TESTING_ONLY;
        process.env.MCP_DB_LIST_PROBE = "off";
        expect(listProbeEnabled()).toBe(false);
    });
});

describe("SQL helpers", () => {
    it("quotes reserved aliases for mysql", () => {
        const queries = connectionSummaryQueries("mysql");
        expect(queries.info).toContain("CURRENT_USER() AS `current_user`");
        expect(queries.info).toContain("VERSION() AS `version`");
        expect(queries.size).toContain("information_schema.tables");
        expect(queries.tablesCount).toContain("information_schema.tables");
    });

    it("keeps the size in the postgres info query", () => {
        const queries = connectionSummaryQueries("postgres");
        expect(queries.info).toContain("current_user as current_user");
        expect(queries.size).toBe("");
        expect(queries.tablesCount).toContain("information_schema.tables");
    });

    it("has a dialect hint per engine", () => {
        expect(sqlDialectHint("mysql")).toContain("DATABASE()");
        expect(sqlDialectHint("mysql")).toContain("`current_user`");
        expect(sqlDialectHint("postgres")).toContain("PostgreSQL");
    });
});
