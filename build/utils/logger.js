/** stderr only: stdout carries the MCP stdio protocol. */
const write = (level, message) => {
    console.error(`${new Date().toISOString()} - mcp-db - ${level} - ${message}`);
};
export const logger = {
    info: (message) => write("INFO", message),
    warn: (message) => write("WARNING", message),
    error: (message) => write("ERROR", message),
};
