import { DatabaseManager } from "../clients/database-manager.js";
import { testingOnly } from "../utils/env.js";
import { runTool, testingField } from "./common.js";

export const listDatabasesDescription = (): string =>
    testingOnly()
        ? "Каталог сервисов тестинга без TCP-probe (available=null, probed=false). " +
          "testing по умолчанию TESTING_NAME. Живая проверка — get_database_info(service). " +
          "MCP_DB_LIST_PROBE=1 включает connect-all"
        : "Список БД и статус подключения. Без testing — prod-реплики из .db.yaml; " +
          "с testing — каталог services из .db-testing.yaml на указанном тестинге. " +
          "Результат кешируется в процессе MCP на 10 минут; после рестарта сервера — живой fetch";

export const listDatabasesSchema = () => ({
    testing: testingField(),
});

export const listDatabasesHandler =
    (manager: DatabaseManager) =>
    async ({ testing }: { testing?: string }) =>
        runTool("list_databases", () => manager.listDatabases(testing));
