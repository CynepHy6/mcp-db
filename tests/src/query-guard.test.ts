import {
    containsDangerousKeyword,
    isQueryTimeoutError,
    looksLikeWriteQuery,
    normalizeQueryText,
    stagingWriteCaution,
    validateQuery,
} from "../../src/utils/query-guard";

describe("validateQuery on prod", () => {
    it("allows a plain SELECT", () => {
        expect(validateQuery("SELECT id FROM users WHERE id = 1", false)).toBe(true);
    });

    it.each([
        "WITH t AS (SELECT 1) SELECT * FROM t",
        "EXPLAIN SELECT 1",
        "SHOW search_path",
        "DESCRIBE users",
        "VALUES (1), (2)",
        "  -- comment\n  select 1",
        "/* note */ SELECT 1",
    ])("allows read statement %p", (query) => {
        expect(validateQuery(query, false)).toBe(true);
    });

    it.each([
        "UPDATE users SET name = 'test' WHERE id = 1",
        "DELETE FROM users WHERE id = 1",
        "INSERT INTO users(id) VALUES (1)",
        "DROP TABLE users",
        "TRUNCATE users",
    ])("blocks a statement that does not start like a read: %p", (query) => {
        expect(validateQuery(query, false)).toBe(false);
    });

    it("blocks a data-modifying CTE behind a SELECT prefix", () => {
        expect(validateQuery("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", false)).toBe(false);
    });

    it.each([
        "WITH u AS (UPDATE t SET x = 1 RETURNING *) SELECT * FROM u",
        "WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i",
        "SELECT 1; DROP TABLE t",
        "SELECT 1;\nCREATE TABLE t (id int)",
        "select 1; alter table t add column x int",
        "SELECT 1; GRANT ALL ON t TO someone",
        "SELECT 1; EXECUTE stmt",
    ])("blocks a write keyword anywhere in the query: %p", (query) => {
        expect(validateQuery(query, false)).toBe(false);
    });

    it.each([
        "SELECT updated_at, created_at, deleted_at FROM users",
        "SELECT insert_count, executed_by FROM jobs",
        "SELECT * FROM grants_log",
    ])("does not match keywords inside identifiers: %p", (query) => {
        expect(validateQuery(query, false)).toBe(true);
    });

    it("matches whole words next to punctuation", () => {
        expect(containsDangerousKeyword("(DELETE FROM T)")).toBe(true);
        expect(containsDangerousKeyword("X.UPDATE")).toBe(true);
        expect(containsDangerousKeyword("UPDATED")).toBe(false);
        expect(containsDangerousKeyword("_DELETE")).toBe(false);
    });

    it("strips comments before the prefix check", () => {
        expect(normalizeQueryText("-- x\n/* y */ select 1")).toBe("SELECT 1");
    });
});

describe("validateQuery on testing", () => {
    it.each([
        "UPDATE teachers SET name = 'test' WHERE id = 1",
        "DELETE FROM users WHERE id = 1",
        "INSERT INTO users(id) VALUES (1)",
    ])("allows any query: %p", (query) => {
        expect(validateQuery(query, true)).toBe(true);
    });
});

describe("staging caution", () => {
    it("is set for a write on a staging stand only", () => {
        expect(stagingWriteCaution("s2", "UPDATE crm SET x = 1")).toContain("не рекомендуется");
        expect(stagingWriteCaution("s2", "SELECT 1")).toBeNull();
        expect(stagingWriteCaution("test-alpha", "UPDATE crm SET x = 1")).toBeNull();
        expect(stagingWriteCaution(null, "UPDATE crm SET x = 1")).toBeNull();
    });

    it("treats anything that does not start like a read as a write", () => {
        expect(looksLikeWriteQuery("delete from t")).toBe(true);
        expect(looksLikeWriteQuery("-- c\nselect 1")).toBe(false);
    });
});

describe("isQueryTimeoutError", () => {
    it("recognises Postgres and MySQL timeouts", () => {
        expect(isQueryTimeoutError("canceling statement due to statement timeout")).toBe(true);
        expect(
            isQueryTimeoutError("Query execution was interrupted, maximum statement execution time exceeded"),
        ).toBe(true);
        expect(isQueryTimeoutError("syntax error at or near")).toBe(false);
    });
});
