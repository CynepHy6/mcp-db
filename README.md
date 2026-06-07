# MCP сервер для работы с БД

Безопасный MCP (Model Context Protocol) сервер для работы с базами данных без передачи кредов в удаленное API.

## Возможности

- **Безопасность**: prod (без `testing`) — только SELECT/WITH/EXPLAIN; тестинг (`testing` задан) — любые SQL
- **Два конфига**: `.db.yaml` (prod) и `.db-testing.yaml` (тестинги)
- **Мониторинг**: логирование запросов в `mcp-db-server.log`

## Установка

```bash
git clone https://github.com/CynepHy6/mcp-db.git mcp-db
cd mcp-db
python3 -m venv venv
source venv/bin/activate
pip install -r requirements-mcp.txt
```

## Настройка

```bash
cp .db.yaml.example .db.yaml
cp .db-testing.yaml.example .db-testing.yaml
# Заполните креды в обоих файлах
```

### Prod — `.db.yaml`

```yaml
crm:
  pgsql-crm-repl.example.com: 5432
  readonly_user: password
```

### Тестинг — `.db-testing.yaml`

Каталог сервисов — в `.db-testing.yaml.example` (386 сервисов, без кредов).

```yaml
user: YOUR_TESTING_USER
password: YOUR_TESTING_PASSWORD
host_template: "{{env}}-example.com"   # example.com → реальный суффикс хоста БД тестинга
engines:                               # port и type обязательны; port — из инфраструктуры тестинга
  mysql8: { port: 0, type: mysql }
  pg11:   { port: 0, type: postgres }
  pg15:   { port: 0, type: postgres }
  pg9:    { port: 0, type: postgres }
services:
  crm: pg15
  trm: pg11
  timetable:
    engine: mysql8
    database: timetable
```

Пути по умолчанию: оба файла рядом с `mcp-db-server.py`. Переопределение:

- `MCP_DB_CONFIG` — prod
- `MCP_DB_TESTING_CONFIG` — тестинг

## MCP-инструменты

| Инструмент | Prod | Тестинг |
|---|---|---|
| `execute_query` | `service`, `query` | + `testing` |
| `get_tables_schemas` | `service` | + `testing` |
| `get_database_info` | `service` | + `testing` |
| `list_databases` | без параметров | `testing` |

```json
{
  "service": "crm",
  "testing": "my-env",
  "query": "SELECT 1"
}
```

## Диагностика

```bash
./mcp-server --test
./mcp-server --test my-env
./mcp-server --list-databases my-env
venv/bin/python -m pytest test_mcp_db_server.py -q
```

Опционально: `MCP_DB_CONNECT_TIMEOUT`, `MCP_DB_LIST_MAX_WORKERS`.

## Безопасность

- Prod без `testing` — read-only
- С `testing` — write разрешён
- `.db.yaml` и `.db-testing.yaml` не в git
