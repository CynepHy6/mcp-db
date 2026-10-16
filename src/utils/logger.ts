/** stderr only: stdout carries the MCP stdio protocol. */
const write = (level: string, message: string) => {
    console.error(`${new Date().toISOString()} - mcp-db - ${level} - ${message}`);
};

export const logger = {
    info: (message: string) => write("INFO", message),
    warn: (message: string) => write("WARNING", message),
    error: (message: string) => write("ERROR", message),
};
