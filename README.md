# mcp-db

MCP-сервер (stdio) для PostgreSQL и MySQL в Cursor и Claude Code: prod-реплики и тестинги Skyeng Platform. Креды лежат в локальных YAML и никуда не уходят.

- **Prod** (без `testing` или `testing: "prod"`) — только чтение. Каждый запрос идёт в read-only транзакции на стороне БД, запись отклоняет сама БД.
- **Тестинг и стейджинг** (`testing` задан) — любые SQL.

## Быстрый старт (npx, без клона)

```json
{
  "mcpServers": {
    "db": {
      "command": "npx",
      "args": ["-y", "github:CynepHy6/mcp-db#semver:^1"],
      "env": {
        "MCP_DB_CONFIG": "/absolute/path/to/.db.yaml",
        "MCP_DB_TESTING_CONFIG": "/absolute/path/to/.db-testing.yaml"
      }
    }
  }
}
```

При npx пути к конфигам задавать абсолютными: файлы рядом с пакетом в кеше npx не ищутся.

### Версия в `args`

| Ref | Пример `args` | Когда использовать |
|-----|---------------|-------------------|
| диапазон `v1.x` | `["-y", "github:CynepHy6/mcp-db#semver:^1"]` | по умолчанию; при старте подтягивается максимальный тег `v1.x` |
| конкретный тег | `["-y", "github:CynepHy6/mcp-db#v1.0.0"]` | зафиксировать версию |

Каждый релиз помечен git-тегом `v{version}` (история — [CHANGELOG.md](CHANGELOG.md)). Тег указывает на ветку `dist` с собранным `build/`. Если новый релиз не подтянулся — `npx clear-npx-cache` и reload MCP.

## Альтернатива: локальный клон

```bash
git clone https://github.com/CynepHy6/mcp-db.git
cd mcp-db
npm install && npm run compile
cp .db.yaml.example .db.yaml
cp .db-testing.yaml.example .db-testing.yaml   # заполнить креды
```

```json
{
  "mcpServers": {
    "db": { "command": "/absolute/path/to/mcp-db/mcp-server" }
  }
}
```

`mcp-server` запускает `node build/index.js`. Без `MCP_DB_CONFIG` сервер берёт `.db.yaml` из корня клона, без `MCP_DB_TESTING_CONFIG` — `.db-testing.yaml` рядом с `.db.yaml`.

## Переменные окружения

| Переменная | По умолчанию | Что делает |
|------------|--------------|-----------|
| `MCP_DB_CONFIG` | `<корень пакета>/.db.yaml` | prod-каталог. Файла нет или он не объект — сервер не стартует. Пустой каталог — `{}` |
| `MCP_DB_TESTING_CONFIG` | `.db-testing.yaml` рядом с prod-конфигом | каталог тестингов. Необязателен; ошибка в нём видна в ответе каждого вызова с `testing`, prod работает |
| `TESTING_NAME` | — | стенд, если `testing` в вызове не передан. Заданный `TESTING_NAME` уводит вызовы без `testing` на этот стенд; prod тогда — явный `testing: "prod"` |
| `MCP_DB_TESTING_ONLY` | выкл. | `1`/`true`/`yes`/`on`: prod-каталог не открывается, вызов без стенда — ошибка; свой текст instructions и описаний tools |
| `MCP_DB_LIST_PROBE` | вкл., при `MCP_DB_TESTING_ONLY` — выкл. | `list_databases` подключается к каждой БД. Выключено — каталог без TCP (`available: null`, `probed: false`) |
| `MCP_DB_CONNECT_TIMEOUT` | `2` | таймаут подключения, секунды |
| `MCP_DB_QUERY_TIMEOUT` | `30` | лимит SQL в `execute_query`, секунды; `0` — без лимита |
| `MCP_DB_MAX_CONCURRENT_TOOL_CALLS` | `2` | сколько вызовов tools одновременно ходят в БД |
| `MCP_DB_LIST_MAX_WORKERS` | `min(16, число БД)` | параллельные подключения внутри одного `list_databases` |

## Prod — `.db.yaml`

Ключ верхнего уровня — имя БД (`service` в tools). Два формата записи.

Короткий (`<host>: <port>` и `<user>: <password>`):

```yaml
crm:
  pgsql-crm-repl.example.com: 5432
  readonly_user: YOUR_PASSWORD
  block_store: vimbox_store_crm   # необязательно

learning_groups_storage:
  pgsql-learning-groups-storage-repl.example.com: 5432
  readonly_user: YOUR_PASSWORD
```

Явный:

```yaml
timetable:
  host: mysql-timetable-repl.example.com
  port: 3306
  user: readonly_user
  password: YOUR_PASSWORD
  type: mysql          # необязательно
  database: timetable  # необязательно, по умолчанию — ключ записи
```

Без `type` тип определяется по хосту (`mysql-…` → MySQL, `pgsql-…` → PostgreSQL), затем по порту (`3306` → MySQL), иначе PostgreSQL. Запись без хоста, порта, пользователя или пароля пропускается. Секция `_testing` в этом файле — ошибка: тестинги живут в отдельном файле.

## Тестинг — `.db-testing.yaml`

```yaml
user: YOUR_TESTING_USER
password: YOUR_TESTING_PASSWORD
host_template: "{{env}}-example.com"                       # {{env}} → имя стенда
staging_host_template: "yc-staging-{{env}}-db.example.com" # необязательно, для s2, s6, …
engines:                       # port и type обязательны
  pg11:   { port: 5432, type: postgres }
  pg15:   { port: 5433, type: postgres }
  mysql8: { port: 3306, type: mysql }
services:
  crm: pg15                    # БД crm_auto_<suffix>
  trm: pg11
  timetable:
    engine: mysql8
    database: timetable        # своё имя БД
  skysmart_english:
    engine: pg11
    block_store: vimbox_store_english_skysmart
```

- Имя БД по умолчанию — `{service}_auto_{suffix}`, `suffix` — имя стенда без префикса `test-` (`test-y10` → `crm_auto_y10`).
- `yNN` (shortName qa-panel) — алиас `test-yNN`.
- Стейджинги `sN` берут хост из `staging_host_template`, без него — из `host_template`. Запись туда не блокируется, но на write-запрос `execute_query` добавляет в ответ поле `caution`.
- Полный каталог сервисов без кредов — [.db-testing.yaml.example](.db-testing.yaml.example).

## Tools

| Tool | Параметры | Что отдаёт |
|------|-----------|-----------|
| `execute_query` | `query`, `service` [, `testing`, `timeout`] | строки, `rows_count`, `db_type`, `sql_dialect_hint`; `caution` на write в стейджинг |
| `get_tables_schemas` | `service` [, `testing`, `table_names`] | колонки и индексы таблиц (`public` для PostgreSQL, текущая БД для MySQL) |
| `list_databases` | [`testing`] | каталог и статус подключения; кеш в процессе на 10 минут, отдельно для prod и каждого стенда |
| `get_database_info` | `service` [, `testing`] | размер, таблицы по размеру, `connection_config.db_type` |

`timeout` — секунды, по умолчанию 30, `0` — без лимита. PostgreSQL — `statement_timeout`, MySQL — `MAX_EXECUTION_TIME` и клиентский таймаут запроса.

## Read-only на prod

Без `testing` сервер проверяет запрос дважды:

1. Фильтр текста: запрос начинается с `SELECT`, `WITH`, `EXPLAIN`, `SHOW`, `DESCRIBE` или `VALUES` и не содержит отдельным словом `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `EXEC`, `EXECUTE`. Так отсекается, например, `WITH d AS (DELETE … RETURNING *) SELECT …`. Слово внутри строкового литерала тоже отсекается.
2. Транзакция БД: сессия открывается `BEGIN READ ONLY` (PostgreSQL) или `START TRANSACTION READ ONLY` (MySQL) и закрывается `ROLLBACK`. Запрос идёт одним оператором (PostgreSQL — extended protocol, MySQL — без `multipleStatements`), поэтому выйти из транзакции через `COMMIT; …` нельзя. Запись, которую пропустил фильтр, отклоняет сама БД.

В read-only транзакции идут и служебные запросы `list_databases`, `get_database_info`, `get_tables_schemas` к prod. Учётке prod-реплики всё равно стоит выдавать только права на чтение.

## Разработка

```bash
npm install
npm test
npm run compile
./mcp-server --test            # подключения prod
./mcp-server --test test-y10   # подключения стенда
./mcp-server --list-databases test-y10
./test-tool.sh list_databases '{"testing": "test-y10"}'
```

Релиз: поднять `version` в `package.json`, дописать [CHANGELOG.md](CHANGELOG.md), push в `master`. CI прогоняет тесты, собирает `build/`, публикует ветку `dist` и тег `v{version}`.
