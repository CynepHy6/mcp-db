#!/usr/bin/env node
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DatabaseManager } from "./clients/database-manager.js";
import { executeQueryDescription, executeQueryHandler, executeQuerySchema } from "./tools/execute-query.js";
import { getDatabaseInfoDescription, getDatabaseInfoHandler, getDatabaseInfoSchema } from "./tools/get-database-info.js";
import { getTablesSchemasDescription, getTablesSchemasHandler, getTablesSchemasSchema, } from "./tools/get-tables-schemas.js";
import { listDatabasesDescription, listDatabasesHandler, listDatabasesSchema } from "./tools/list-databases.js";
import { connectTimeoutSec, defaultQueryTimeoutSec } from "./utils/env.js";
import { logger } from "./utils/logger.js";
import { mcpServerInstructions } from "./utils/mcp-server-instructions.js";
import { coerceTesting } from "./utils/testing-env.js";
const __filename = fileURLToPath(import.meta.url);
/** Package root: the default `.db.yaml` of a local clone lives here. */
const packageRoot = path.resolve(path.dirname(__filename), "..");
const { version } = createRequire(import.meta.url)("../package.json");
const showHelp = () => {
    console.log("MCP сервер для работы с БД Skyeng Platform\n");
    console.log("Использование:");
    console.log("  mcp-db                            - Запуск MCP сервера (stdio)");
    console.log("  mcp-db --help                     - Показать эту справку");
    console.log("  mcp-db --list-databases [my-env]  - Prod или каталог тестинга");
    console.log("  mcp-db --test [my-env]            - Проверить подключения\n");
    console.log("Доступные инструменты MCP:");
    console.log("  • execute_query         - SQL к prod (service) или тестингу (service + testing)");
    console.log("  • get_tables_schemas    - Схемы таблиц (service [, testing])");
    console.log("  • list_databases        - Prod-реплики или каталог тестинга (list_databases + testing)");
    console.log("  • get_database_info     - Детальная информация о БД (service [, testing])\n");
    console.log("Конфигурация:");
    console.log("  .db.yaml         — prod-реплики (по умолчанию в корне пакета)");
    console.log("  .db-testing.yaml — тестинги (рядом с .db.yaml)");
    console.log("  MCP_DB_CONFIG=/path/to/.db.yaml — prod-конфиг");
    console.log("  MCP_DB_TESTING_CONFIG=/path/to/.db-testing.yaml — тестинг-конфиг");
    console.log("  MCP_DB_MAX_CONCURRENT_TOOL_CALLS=2 — лимит одновременных DB tool calls");
};
const printDatabases = (databases, countWorking) => {
    let working = 0;
    for (const [name, info] of Object.entries(databases)) {
        const status = info.probed === false ? "○" : info.available ? "✅" : "❌";
        console.log(`  ${status} ${name}`);
        if (info.available || info.probed === false) {
            if (info.available) {
                working += 1;
            }
            console.log(`      └─ ${info.connection_config.host} / ${info.connection_config.database}`);
        }
        else {
            console.log(`      └─ Ошибка: ${info.error ?? "Неизвестная ошибка"}`);
        }
    }
    return countWorking ? working : 0;
};
const runCli = async (manager, args) => {
    const [arg, envArg] = args;
    if (arg === "--list-databases") {
        try {
            const resolved = coerceTesting(envArg);
            const databases = await manager.listDatabases(envArg);
            console.log(`Доступные базы данных (${resolved ? `тестинг ${resolved}` : "prod"}):`);
            printDatabases(databases, false);
            console.log(`\nВсего: ${Object.keys(databases).length}`);
        }
        catch (error) {
            console.log(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
    }
    if (arg === "--test") {
        try {
            const testing = coerceTesting(envArg);
            console.log(`🔍 Тестирование подключений (${testing ? `тестинг ${testing}` : "prod"})...`);
            const databases = await manager.listDatabasesFresh(testing);
            const working = printDatabases(databases, true);
            console.log(`\n📊 Результат: ${working}/${Object.keys(databases).length} подключений работают`);
        }
        catch (error) {
            console.log(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
    }
    console.log(`Неизвестный аргумент: ${arg}`);
    console.log("Используйте --help для справки");
};
const startServer = async (manager) => {
    const server = new McpServer({ name: "mcp-db", version }, { capabilities: { tools: {} }, instructions: mcpServerInstructions() });
    server.tool("execute_query", executeQueryDescription(), executeQuerySchema(), executeQueryHandler(manager));
    server.tool("get_tables_schemas", getTablesSchemasDescription(), getTablesSchemasSchema(), getTablesSchemasHandler(manager));
    server.tool("list_databases", listDatabasesDescription(), listDatabasesSchema(), listDatabasesHandler(manager));
    server.tool("get_database_info", getDatabaseInfoDescription(), getDatabaseInfoSchema(), getDatabaseInfoHandler(manager));
    logger.info("Запуск MCP сервера для работы с БД Skyeng Platform");
    logger.info(`Загружено БД: ${Object.keys(manager.connections).length}`);
    await server.connect(new StdioServerTransport());
};
async function main() {
    const args = process.argv.slice(2);
    if (args[0] === "--help" || args[0] === "-h") {
        showHelp();
        return;
    }
    let manager;
    try {
        logger.info(`Таймаут подключения к БД установлен: ${connectTimeoutSec()} сек`);
        logger.info(`Таймаут выполнения SQL по умолчанию: ${defaultQueryTimeoutSec()} сек (0 = без лимита; параметр timeout / MCP_DB_QUERY_TIMEOUT)`);
        manager = new DatabaseManager({ defaultConfigDir: packageRoot });
    }
    catch (error) {
        // A missing or broken prod config is fatal, as before.
        logger.error(`Ошибка загрузки prod-конфигурации: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
    if (args.length > 0) {
        await runCli(manager, args);
        return;
    }
    try {
        await startServer(manager);
    }
    catch (error) {
        logger.error(`Error starting mcp-db server: ${String(error)}`);
        process.exit(1);
    }
}
main();
