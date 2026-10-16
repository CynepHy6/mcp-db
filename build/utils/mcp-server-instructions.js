import { testingOnly } from "./env.js";
/** MCP server instructions (InitializeResult.instructions) — visible to the agent before tool choice. */
export const MCP_SERVER_INSTRUCTIONS_GENERIC = `
MCP user-DB: prod-реплики и тестинги Skyeng Platform.

Параметры:
- service — имя сервиса/БД (crm, timetable, learning_groups_storage, …)
- testing — имя окружения для тестинга (test-y10, test-alpha, my-env, …);
  shortName qa-panel yNN (y10) принимается как алиас test-yNN; без testing = prod (read-only)
- timeout — лимит выполнения SQL в секундах (по умолчанию 30; 0 = без лимита). При timeout
  оптимизируй запрос (WHERE/LIMIT/индексы), не поднимай лимит без нужды.

Перед первым SQL к незнакомому service вызови get_database_info или list_databases и смотри connection_config.db_type.
SQL пиши в синтаксисе db_type из ответа; execute_query тоже возвращает db_type и sql_dialect_hint.

PostgreSQL (большинство сервисов, engines pg11/pg15/pg9):
- current_database(), current_user, version()
- SHOW TABLES нет — information_schema или get_tables_schemas

MySQL (например timetable → engine mysql8):
- DATABASE(), USER() или CURRENT_USER() AS \`current_user\`, VERSION()
- зарезервированные алиасы (current_user, order, …) — обратные кавычки

Безопасность: prod без testing — только SELECT/WITH/EXPLAIN; с testing — любые SQL.
На prod запрос идёт в read-only транзакции БД, один SQL-оператор за вызов.
Стейджинги (s2, s6, ...) — тот же параметр testing; технически запись разрешена и не опасна
для прод-пользователей, но прямое изменение данных на стейджинге не рекомендуется без явной
необходимости — предпочитай SELECT (см. caution в ответе execute_query при write-запросе).
Ошибка конфига тестинга (нет port и т.п.) — в error от execute_query, prod не затрагивается.
`.trim();
export const MCP_SERVER_INSTRUCTIONS_TESTING_ONLY = `
mcp-db-testing: прямой SQL к БД тестингов Skyeng (внутренний контур). Prod-каталога нет.

Параметры:
- service — ключ каталога (video, trm, math, …)
- testing — стенд test-yNN / sN / qa-panel yNN. Если не передан — TESTING_NAME (личный стенд).
  Явный testing побеждает, в том числе чужой стенд. Не подставляй чужой стенд сам.
- timeout — лимит SQL в секундах (по умолчанию 30; 0 = без лимита). При timeout сузь запрос.

list_databases — каталог без TCP-probe (available=null, probed=false).
Живой коннект и схема — get_database_info(service[, testing]) или execute_query.
Перед первым SQL смотри connection_config.db_type и пиши в этом диалекте.

PostgreSQL (pg9/pg11/pg15): current_database(), current_user, version(); SHOW TABLES нет.
MySQL (mysql8): DATABASE(), USER() / CURRENT_USER() AS \`current_user\`, VERSION().

Write на любом testing разрешён. Стейджинг sN — только если явно попросили; иначе SELECT.
`.trim();
export const mcpServerInstructions = () => testingOnly() ? MCP_SERVER_INSTRUCTIONS_TESTING_ONLY : MCP_SERVER_INSTRUCTIONS_GENERIC;
