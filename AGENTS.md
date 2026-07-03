# База знаний проекта

**Сгенерировано:** 2026-06-07
**Commit:** 70f4a17
**Branch:** master

## Обзор

Локальный MCP-сервер (stdio) для PostgreSQL и MySQL. Runtime — `mcp-db-server.py`.

**Два конфига:**
- `.db.yaml` — prod-реплики, read-only
- `.db-testing.yaml` — тестинги, параметры `service` + `testing`

## Структура

```text
mcp-db/
├── mcp-db-server.py
├── mcp-server
├── test_mcp_db_server.py
├── .db.yaml                 # prod, локально
├── .db-testing.yaml         # тестинг, локально
├── .db.yaml.example
├── .db-testing.yaml.example
└── venv/
```

## Куда смотреть

| Задача | Где |
| --- | --- |
| MCP tools | `mcp-db-server.py` |
| Prod-конфиг | `_load_prod_config`, `_normalize_prod_config_entry` |
| Тестинг/стейджинг | `_load_testing_config`, `_resolve_testing_connection`, `_resolve_testing_host`, `_is_staging_env` |
| Write gate | `_validate_query` — write если `testing` задан |

## Точки входа

1. `./mcp-server` — MCP stdio
2. `./mcp-server --test [env]`, `--list-databases [env]`
3. `MCP_DB_CONFIG`, `MCP_DB_TESTING_CONFIG`

## Соглашения

- **MCP instructions:** `MCP_SERVER_INSTRUCTIONS` в `mcp-db-server.py` → `Server(instructions=...)` (видны агенту как serverUseInstructions)
- **Prod:** `execute_query(service="crm", query="...")`
- **Тестинг:** + `testing="..."`; конфиг из `.db-testing.yaml`
- **Стейджинг:** тот же параметр `testing`, имена вида `s2`, `s6` (регэксп `STAGING_ENV_PATTERN` = `^s\d+$`).
  Хост резолвится через `staging_host_template` из `.db-testing.yaml` (если задан), иначе через общий
  `host_template`. Пример реального адреса: `yc-staging-{{env}}-db.skyeng.link` → для `s2` даёт
  `yc-staging-s2-db.skyeng.link`. Запись на стейджинг технически разрешена и не опасна для прод-пользователей,
  но не рекомендуется без явной необходимости — `execute_query` при write-запросе на стейджинг добавляет
  в ответ поле `caution` (см. `_staging_write_caution`)
- **SQL:** смотреть `db_type` / `sql_dialect_hint` в ответе `execute_query` или `get_database_info`; MySQL ≠ PostgreSQL синтаксис
- `.db-testing.yaml` опционален (без него testing/staging недоступны)
- `_testing` в `.db.yaml` — ошибка, только отдельный файл
- Не коммитить `.db.yaml`, `.db-testing.yaml`

## Команды

```bash
venv/bin/python -m pytest test_mcp_db_server.py -q
./mcp-server --test my-env
```
