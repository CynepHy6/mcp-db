import { DatabaseManager } from "../../src/clients/database-manager";
import { runTool } from "../../src/tools/common";
import { executeQueryHandler, executeQuerySchema } from "../../src/tools/execute-query";
import { getDatabaseInfoHandler } from "../../src/tools/get-database-info";
import { getTablesSchemasHandler } from "../../src/tools/get-tables-schemas";
import { listDatabasesHandler } from "../../src/tools/list-databases";
import { MCP_SERVER_INSTRUCTIONS_GENERIC, mcpServerInstructions } from "../../src/utils/mcp-server-instructions";
import { toJson } from "../../src/utils/json";

const text = (result: any) => result.content[0].text as string;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const trackingManager = (delayMs: number) => {
    const state = { active: 0, maxActive: 0 };
    const manager = {
        async executeQuery(query: string) {
            state.active += 1;
            state.maxActive = Math.max(state.maxActive, state.active);
            try {
                await sleep(delayMs);
                return { success: true, query };
            } finally {
                state.active -= 1;
            }
        },
    } as unknown as DatabaseManager;
    return { manager, state };
};

describe("tool handlers", () => {
    it("run DB work in parallel up to MCP_DB_MAX_CONCURRENT_TOOL_CALLS", async () => {
        process.env.MCP_DB_MAX_CONCURRENT_TOOL_CALLS = "2";
        const { manager, state } = trackingManager(20);
        const handler = executeQueryHandler(manager);

        const results = await Promise.all([
            handler({ query: "SELECT 1", service: "crm" }),
            handler({ query: "SELECT 2", service: "crm" }),
        ]);

        expect(results.map((r) => JSON.parse(text(r)).query)).toEqual(["SELECT 1", "SELECT 2"]);
        expect(state.maxActive).toBe(2);
    });

    it("respect a global limit of 1", async () => {
        process.env.MCP_DB_MAX_CONCURRENT_TOOL_CALLS = "1";
        const { manager, state } = trackingManager(10);
        const handler = executeQueryHandler(manager);

        await Promise.all([
            handler({ query: "SELECT 1", service: "crm" }),
            handler({ query: "SELECT 2", service: "crm" }),
            handler({ query: "SELECT 3", service: "crm" }),
        ]);

        expect(state.maxActive).toBe(1);
    });

    it("require query and service", async () => {
        const manager = {} as DatabaseManager;
        expect(text(await executeQueryHandler(manager)({ query: "", service: "crm" }))).toBe(
            "Ошибка: необходимо указать query и service",
        );
        expect(text(await getDatabaseInfoHandler(manager)({}))).toBe("Ошибка: необходимо указать service");
        expect(text(await getTablesSchemasHandler(manager)({}))).toBe("Ошибка: необходимо указать service");
    });

    it("turn a thrown error into Ошибка text", async () => {
        const manager = {
            async listDatabases() {
                throw new Error("list_databases: mcp-db-testing не открывает prod");
            },
        } as unknown as DatabaseManager;
        expect(text(await listDatabasesHandler(manager)({}))).toBe(
            "Ошибка: list_databases: mcp-db-testing не открывает prod",
        );
    });

    it("serialise results as indented JSON with unicode kept", async () => {
        const result = await runTool("x", async () => ({ ok: "да", big: BigInt(5), bin: Buffer.from([1, 255]) }));
        expect(text(result)).toBe(toJson({ ok: "да", big: "5", bin: "\\x01ff" }));
        expect(text(result)).toContain('"ok": "да"');
    });
});

describe("schemas and instructions", () => {
    it("execute_query accepts a non-negative integer timeout only", () => {
        const schema = executeQuerySchema();
        expect(schema.timeout.safeParse(0).success).toBe(true);
        expect(schema.timeout.safeParse(-1).success).toBe(false);
        expect(schema.timeout.safeParse(1.5).success).toBe(false);
        expect(schema.testing.safeParse(undefined).success).toBe(true);
    });

    it("switch to the testing-only text", () => {
        expect(mcpServerInstructions()).toBe(MCP_SERVER_INSTRUCTIONS_GENERIC);
        process.env.MCP_DB_TESTING_ONLY = "1";
        expect(mcpServerInstructions().toLowerCase()).toContain("prod-каталога нет");
        expect(mcpServerInstructions()).not.toContain("без testing = prod");
    });
});
