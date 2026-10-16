# Changelog

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/); нумерация версий — [Semantic Versioning](https://semver.org/lang/ru/).

## [1.0.0] - 2026-10-16

Сервер переписан с Python на TypeScript. Запуск — `npx -y github:CynepHy6/mcp-db#semver:^1` или `./mcp-server` из клона; venv и `requirements-mcp.txt` больше не нужны.

### Безопасность

- **Prod читается только в read-only транзакции БД.** Каждая prod-сессия открывается `BEGIN READ ONLY` (PostgreSQL) или `START TRANSACTION READ ONLY` (MySQL) и закрывается `ROLLBACK`; запрос идёт одним оператором. Запись отклоняет сама БД, даже если текстовый фильтр её пропустил.
- **Исправлен фильтр запрещённых слов.** В Python-версии шаблон `\\b<слово>\\b` искал буквальный обратный слеш и не срабатывал никогда, поэтому `WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d` проходил на prod как чтение. Теперь `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `EXEC`, `EXECUTE` ловятся как отдельные слова.

### Без изменений

- Tools `execute_query`, `get_tables_schemas`, `list_databases`, `get_database_info` с прежними параметрами и описаниями.
- Конфиги `MCP_DB_CONFIG` и `MCP_DB_TESTING_CONFIG` в тех же форматах, включая короткую prod-запись `<host>: <port>` / `<user>: <password>`, `staging_host_template`, алиас `yNN` → `test-yNN`, имя БД `{service}_auto_{suffix}`.
- `TESTING_NAME`, `MCP_DB_TESTING_ONLY`, `MCP_DB_LIST_PROBE`, `MCP_DB_CONNECT_TIMEOUT`, `MCP_DB_QUERY_TIMEOUT`, `MCP_DB_MAX_CONCURRENT_TOOL_CALLS`, `MCP_DB_LIST_MAX_WORKERS`; кеш `list_databases` на 10 минут; `caution` на write в стейджинг; тексты ошибок.

### Изменено

- На prod нельзя отправить несколько операторов одним запросом (`SELECT 1; SELECT 2`).
- Фильтр prod теперь отклоняет запросы, где запрещённое слово стоит в строковом литерале или после `FOR` (`… WHERE action = 'DELETE'`, `SELECT … FOR UPDATE`).
- Лог пишется только в stderr; файла `mcp-db-server.log` больше нет.
- PostgreSQL: TLS без проверки сертификата, при отказе сервера — без TLS (как `sslmode=prefer` у libpq). `bigint` в пределах безопасного целого — число, больше — строка; даты и время — текст сервера.
- MySQL: даты и время — текст сервера; колонки `information_schema` в `get_tables_schemas` читаются по явным алиасам.
