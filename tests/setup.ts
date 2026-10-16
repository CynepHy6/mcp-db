const ENV_KEYS = [
    "MCP_DB_CONFIG",
    "MCP_DB_TESTING_CONFIG",
    "MCP_DB_TESTING_ONLY",
    "MCP_DB_LIST_PROBE",
    "MCP_DB_CONNECT_TIMEOUT",
    "MCP_DB_QUERY_TIMEOUT",
    "MCP_DB_LIST_MAX_WORKERS",
    "MCP_DB_MAX_CONCURRENT_TOOL_CALLS",
    "TESTING_NAME",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const key of ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    // Logs go to stderr; keep the test output readable.
    jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = saved[key];
        }
    }
    jest.restoreAllMocks();
});
