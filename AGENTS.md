# mcp-db — инструкции для агента

MCP-сервер (stdio) для PostgreSQL и MySQL: prod-реплики read-only и тестинги. Точка входа — `src/index.ts` (регистрация tools, `instructions`, CLI `--test` / `--list-databases`). После правок: `npm test`, `npm run compile`, **поднять `version` в `package.json`**, дописать `CHANGELOG.md`, push в `master` (CI → `dist` + git-тег `v{version}`) и reload MCP.

Подробности для людей — [README.md](README.md).

## Релиз

`.github/workflows/publish-dist.yml`: на push в `master` читает `version` из `package.json`. Тег `v{version}` уже есть — только тесты. Нет — тесты, `npm run compile`, на ветку `dist` уходят `build/` и runtime-only `package.json`, ставится тег.

**Скрипт сборки — `compile`, не `build`:** `npx` + `github:` ломается, когда в `package.json` есть скрипт `build` (npm/cli#4003). На `dist` нет `devDependencies` и compile-скриптов.

## Структура кода

```text
src/
  index.ts                      # McpServer, tools, CLI
  clients/
    database-manager.ts         # конфиги → цель (prod / стенд), execute, info, schemas, list + кеш
    db-session.ts               # SessionRunner: readOnly, таймауты; выбор драйвера по db_type
    postgres-session.ts         # pg: BEGIN READ ONLY … ROLLBACK, extended protocol, sslmode=prefer
    mysql-session.ts            # mysql2: START TRANSACTION READ ONLY … ROLLBACK, COMMIT на тестинге
  tools/
    common.ts                   # описания service/testing, runTool (семафор, «Ошибка: …»)
    execute-query.ts, get-tables-schemas.ts, list-databases.ts, get-database-info.ts
  utils/
    config.ts                   # .db.yaml (вкл. короткий формат), .db-testing.yaml, YAML 1.1
    env.ts                      # переменные окружения и таймауты
    testing-env.ts              # yNN → test-yNN, sN, TESTING_NAME
    query-guard.ts              # фильтр prod, caution стейджинга, распознавание таймаута
    sql.ts                      # служебные запросы по диалекту
    semaphore.ts, json.ts, logger.ts, mcp-server-instructions.ts
tests/
  src/       # utils, конфиги
  clients/   # DatabaseManager с фейковым SessionRunner; сессии с замоканными pg / mysql2
  tools/     # handlers, семафор, схемы
```

## Инварианты

- Prod-сессия (`ConnectionConfig.testing` пуст) всегда `readOnly: true` — для любого запроса, включая служебные. Не добавлять путь к prod в обход `DatabaseManager.session`.
- `validateQuery` — первый фильтр, не гарантия. Гарантия — read-only транзакция и один оператор на запрос.
- Тексты ошибок, instructions и описания tools — на русском; агенты и хаб на них опираются.
- Тесты без живой БД: драйверы мокаются (`jest.mock("pg")`, `jest.mock("mysql2/promise")`) или подменяется `runSession`.
- Не коммитить `.db.yaml`, `.db-testing.yaml`.

## Отладка

```bash
npm run compile
./mcp-server --test test-y10
./test-tool.sh execute_query '{"service":"crm","testing":"test-y10","query":"SELECT 1"}'
```
