import asyncio
import copy
import json
import pytest
import importlib.util
import sys
import threading
import time

# Фиктивные хосты для тестов конфигурации (не prod/test инфраструктура).
MYSQL_REPL_HOST = "mysql-example-repl.example.test"
PGSQL_REPL_HOST = "pgsql-example-repl.example.test"
TEST_ENV_HOST = "test-env-local.example.test"
LEGACY_HOST = "legacy-host.example.test"
TESTING_ALPHA = "test-alpha"
TESTING_BETA = "test-beta"

spec = importlib.util.spec_from_file_location("mcp_db_server", "./mcp-db-server.py")
mcp_db_server = importlib.util.module_from_spec(spec)
sys.modules["mcp_db_server"] = mcp_db_server
spec.loader.exec_module(mcp_db_server)
DatabaseManager = mcp_db_server.DatabaseManager

TESTING_CONFIG = """
user: test_user
password: secret
host_template: "{{env}}-local.example.test"
engines:
  mysql8: { port: 13306, type: mysql }
  pg11:   { port: 15432, type: postgres }
  pg15:   { port: 25432, type: postgres }
  pg9:    { port: 35432, type: postgres }
services:
  crm: pg15
  trm: pg11
  timetable:
    engine: mysql8
    database: timetable
  skysmart_english:
    engine: pg11
    block_store: vimbox_store_english_skysmart
""".strip()

PROD_CONFIG = f"prod_db:\n  {LEGACY_HOST}: 5432\n  legacy_user: secret"


@pytest.fixture
def db_manager(tmp_path):
    return create_db_manager_with_config(tmp_path, PROD_CONFIG, TESTING_CONFIG)


def create_db_manager_with_config(tmp_path, prod_text=None, testing_text=None):
    config_path = tmp_path / "db.yaml"
    testing_config_path = tmp_path / "db-testing.yaml"

    config_path.write_text((prod_text or "placeholder: {}\n  x: 1").strip() + "\n", encoding="utf-8")
    if testing_text is not None:
        testing_config_path.write_text(testing_text.strip() + "\n", encoding="utf-8")
    else:
        testing_config_path.unlink(missing_ok=True)

    return DatabaseManager(
        config_path=str(config_path),
        testing_config_path=str(testing_config_path),
    )


@pytest.fixture(autouse=True)
def reset_tool_call_semaphore(monkeypatch):
    monkeypatch.setattr(mcp_db_server, "_tool_call_semaphore", None)
    monkeypatch.setattr(mcp_db_server, "_tool_call_semaphore_loop", None)
    monkeypatch.setattr(mcp_db_server, "_tool_call_semaphore_limit", None)


def _tool_result_payload(result):
    return json.loads(result[0].text)


def test_validate_query_allows_complex_select(db_manager):
    assert db_manager._validate_query("SELECT id FROM users WHERE id = 1") is True


def test_validate_query_blocks_write_for_prod(db_manager):
    query = "UPDATE users SET name = 'test' WHERE id = 1"
    assert db_manager._validate_query(query) is False
    assert db_manager._validate_query(query, testing=None) is False


@pytest.mark.parametrize(
    ("query",),
    [
        ("UPDATE teachers SET name = 'test' WHERE id = 1",),
        ("DELETE FROM users WHERE id = 1",),
        ("INSERT INTO users(id) VALUES (1)",),
    ],
)
def test_validate_query_allows_any_query_on_testing(db_manager, query):
    assert db_manager._validate_query(query, testing=TESTING_ALPHA) is True


def test_load_db_config_supports_legacy_prod_format(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        f"legacy_db:\n  {LEGACY_HOST}: 5432\n  legacy_user: secret\n  block_store: legacy_block_store",
        TESTING_CONFIG,
    )

    assert manager.connections["legacy_db"] == {
        "host": LEGACY_HOST,
        "port": 5432,
        "database": "legacy_db",
        "user": "legacy_user",
        "password": "secret",
        "block_store": "legacy_block_store",
        "db_type": "postgres",
    }


def test_load_prod_config_rejects_testing_section(tmp_path):
    with pytest.raises(ValueError, match="отдельный файл .db-testing.yaml"):
        create_db_manager_with_config(
            tmp_path,
            "_testing:\n  user: u\n  password: p\n  host_template: '{{env}}-x.test'\n  engines:\n    pg11: { port: 15432, type: postgres }\n  services:\n    crm: pg11",
            None,
        )


def test_missing_testing_config_is_optional(tmp_path):
    manager = create_db_manager_with_config(tmp_path, PROD_CONFIG, testing_text=None)
    assert manager.testing_config is None
    with pytest.raises(ValueError, match=".db-testing.yaml не настроен"):
        manager._resolve_testing_connection(TESTING_ALPHA, "crm")


def test_resolve_testing_connection_builds_host_and_database(db_manager):
    conn = db_manager._resolve_testing_connection(TESTING_ALPHA, "crm")

    assert conn == {
        "host": "test-alpha-local.example.test",
        "port": 25432,
        "database": "crm_auto_alpha",
        "user": "test_user",
        "password": "secret",
        "block_store": None,
        "db_type": "postgres",
        "engine": "pg15",
        "testing": TESTING_ALPHA,
        "service": "crm",
    }


def test_resolve_testing_connection_supports_staging_name(db_manager):
    conn = db_manager._resolve_testing_connection(TESTING_BETA, "trm")
    assert conn["host"] == "test-beta-local.example.test"
    assert conn["database"] == "trm_auto_beta"


def test_resolve_testing_connection_supports_database_override(db_manager):
    conn = db_manager._resolve_testing_connection(TESTING_ALPHA, "timetable")
    assert conn["database"] == "timetable"
    assert conn["db_type"] == "mysql"


def test_resolve_testing_connection_includes_block_store(db_manager):
    conn = db_manager._resolve_testing_connection(TESTING_ALPHA, "skysmart_english")
    assert conn["block_store"] == "vimbox_store_english_skysmart"


def test_resolve_testing_connection_raises_for_unknown_service(db_manager):
    with pytest.raises(ValueError, match="unknown_service"):
        db_manager._resolve_testing_connection(TESTING_ALPHA, "unknown_service")


def test_normalize_testing_config_requires_host_template_placeholder(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        PROD_CONFIG,
        """
user: u
password: p
host_template: "fixed-host.example.test"
engines:
  pg11: { port: 15432, type: postgres }
services:
  crm: pg11
""",
    )

    assert manager.testing_config is None
    assert "host_template должен содержать" in manager.testing_config_error


def test_missing_engine_port_stores_config_error_and_surfaces_in_query(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        PROD_CONFIG,
        """
user: u
password: p
host_template: "{{env}}-local.example.test"
engines:
  pg11: { type: postgres }
services:
  crm: pg11
""",
    )

    assert manager.testing_config is None
    assert "не указан port" in manager.testing_config_error
    assert "pg11" in manager.testing_config_error

    result = manager.execute_query_direct("SELECT 1", "crm", testing=TESTING_ALPHA)
    assert result["success"] is False
    assert "не указан port" in result["error"]


def test_missing_engine_type_stores_config_error_and_surfaces_in_query(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        PROD_CONFIG,
        """
user: u
password: p
host_template: "{{env}}-local.example.test"
engines:
  pg11: { port: 15432 }
services:
  crm: pg11
""",
    )

    assert manager.testing_config is None
    assert "не указан type" in manager.testing_config_error
    assert "pg11" in manager.testing_config_error

    result = manager.execute_query_direct("SELECT 1", "crm", testing=TESTING_ALPHA)
    assert result["success"] is False
    assert "не указан type" in result["error"]


def test_normalize_testing_config_raises_for_unknown_engine(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        PROD_CONFIG,
        """
user: u
password: p
host_template: "{{env}}-local.example.test"
engines:
  pg11: { port: 15432, type: postgres }
services:
  crm: pg99
""",
    )

    assert manager.testing_config is None
    assert "неизвестный engine" in manager.testing_config_error


@pytest.mark.parametrize(
    ("host", "port", "expected"),
    [
        (MYSQL_REPL_HOST, 3306, "mysql"),
        (PGSQL_REPL_HOST, 5432, "postgres"),
        (LEGACY_HOST, 5432, "postgres"),
        (TEST_ENV_HOST, 3306, "mysql"),
        (TEST_ENV_HOST, 5432, "postgres"),
        (TEST_ENV_HOST, 25432, "postgres"),
    ],
)
def test_infer_db_type(host, port, expected):
    assert DatabaseManager._infer_db_type(host, port) == expected


def test_load_db_config_detects_db_type_from_host_prefix(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        f"timetable:\n  {MYSQL_REPL_HOST}: 3306\n  ro_user: secret\n\n"
        f"student_vacation:\n  {PGSQL_REPL_HOST}: 5432\n  ro_user: secret",
        TESTING_CONFIG,
    )

    assert manager.connections["timetable"]["db_type"] == "mysql"
    assert manager.connections["student_vacation"]["db_type"] == "postgres"


def test_connection_summary_queries_mysql_quotes_reserved_aliases(db_manager):
    info_query, size_query, tables_query = db_manager._connection_summary_queries("mysql")

    assert "CURRENT_USER() AS `current_user`" in info_query
    assert "VERSION() AS `version`" in info_query
    assert "information_schema.tables" in size_query
    assert "information_schema.tables" in tables_query


def test_execute_query_response_includes_db_type_hint(db_manager):
    result = db_manager.execute_query_direct(
        "SELECT 1 AS ok",
        "crm",
        testing=TESTING_ALPHA,
    )
    if result["success"]:
        assert result["db_type"] == "postgres"
        assert "PostgreSQL" in result["sql_dialect_hint"]
        assert result["timeout_sec"] == mcp_db_server.DEFAULT_QUERY_TIMEOUT_SEC
    elif "не указан port" not in result.get("error", ""):
        assert result.get("db_type") == "postgres"
        assert "PostgreSQL" in result.get("sql_dialect_hint", "")


def test_normalize_query_timeout_default_and_override(monkeypatch):
    monkeypatch.delenv("MCP_DB_QUERY_TIMEOUT", raising=False)
    assert mcp_db_server._normalize_query_timeout_sec(None) == 30
    assert mcp_db_server._normalize_query_timeout_sec(120) == 120
    assert mcp_db_server._normalize_query_timeout_sec(0) == 0
    assert mcp_db_server._normalize_query_timeout_sec("45") == 45

    with pytest.raises(ValueError, match="отрицательным"):
        mcp_db_server._normalize_query_timeout_sec(-1)
    with pytest.raises(ValueError, match="целым числом"):
        mcp_db_server._normalize_query_timeout_sec("slow")


def test_normalize_query_timeout_respects_env(monkeypatch):
    monkeypatch.setenv("MCP_DB_QUERY_TIMEOUT", "90")
    assert mcp_db_server._normalize_query_timeout_sec(None) == 90


def test_apply_query_timeout_sets_server_limits(db_manager, monkeypatch):
    executed = []

    class FakeCursor:
        def execute(self, sql, params=None):
            executed.append((sql, params))

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(db_manager, "_cursor", lambda conn, db_type: FakeCursor())

    db_manager._apply_query_timeout(object(), "postgres", 30)
    assert executed == [("SET statement_timeout = %s", (30000,))]

    executed.clear()
    db_manager._apply_query_timeout(object(), "mysql", 15)
    assert executed == [("SET SESSION MAX_EXECUTION_TIME = %s", (15000,))]

    executed.clear()
    db_manager._apply_query_timeout(object(), "postgres", 0)
    assert executed == []


def test_execute_query_invalid_timeout_returns_error(db_manager):
    result = db_manager.execute_query_direct(
        "SELECT 1",
        "crm",
        testing=TESTING_ALPHA,
        timeout=-5,
    )
    assert result["success"] is False
    assert "отрицательным" in result["error"]


def test_execute_query_passes_timeout_to_connection(db_manager, monkeypatch):
    captured = {}

    class FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class FakeCursor:
        def execute(self, sql, params=None):
            pass

        def fetchall(self):
            return []

        @property
        def description(self):
            return None

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_get_connection(logical_key, conn_config, query_timeout_sec=None):
        captured["query_timeout_sec"] = query_timeout_sec
        return FakeConn()

    monkeypatch.setattr(db_manager, "_get_connection", fake_get_connection)
    monkeypatch.setattr(db_manager, "_cursor", lambda conn, db_type: FakeCursor())
    monkeypatch.setattr(db_manager, "_apply_query_timeout", lambda *args, **kwargs: None)

    result = db_manager.execute_query_direct(
        "SELECT 1",
        "crm",
        testing=TESTING_ALPHA,
        timeout=60,
    )
    assert result["success"] is True
    assert result["timeout_sec"] == 60
    assert captured["query_timeout_sec"] == 60


def test_is_query_timeout_error():
    assert DatabaseManager._is_query_timeout_error(
        "canceling statement due to statement timeout"
    )
    assert DatabaseManager._is_query_timeout_error(
        "Query execution was interrupted, maximum statement execution time exceeded"
    )
    assert not DatabaseManager._is_query_timeout_error("syntax error at or near")


def test_sql_dialect_hint_for_mysql(db_manager):
    hint = DatabaseManager._sql_dialect_hint("mysql")
    assert "DATABASE()" in hint
    assert "`current_user`" in hint


def test_connection_summary_queries_postgres_unchanged(db_manager):
    info_query, size_query, tables_query = db_manager._connection_summary_queries("postgres")

    assert "current_user as current_user" in info_query
    assert size_query == ""
    assert "information_schema.tables" in tables_query


TESTING_CONFIG_WITH_STAGING = """
user: test_user
password: secret
host_template: "{{env}}-local.example.test"
staging_host_template: "yc-staging-{{env}}-db.example.test"
engines:
  mysql8: { port: 13306, type: mysql }
  pg11:   { port: 15432, type: postgres }
  pg15:   { port: 25432, type: postgres }
  pg9:    { port: 35432, type: postgres }
services:
  crm: pg15
  trm: pg11
""".strip()


@pytest.mark.parametrize(
    ("testing", "expected"),
    [
        ("s2", True),
        ("s16", True),
        ("test-alpha", False),
        ("test-y10", False),
        ("my-env", False),
        ("staging", False),
    ],
)
def test_is_staging_env(testing, expected):
    assert DatabaseManager._is_staging_env(testing) is expected


def test_resolve_testing_host_uses_staging_host_template_for_staging_env(tmp_path):
    manager = create_db_manager_with_config(tmp_path, PROD_CONFIG, TESTING_CONFIG_WITH_STAGING)

    assert manager._resolve_testing_host("s2") == "yc-staging-s2-db.example.test"
    assert manager._resolve_testing_host(TESTING_ALPHA) == "test-alpha-local.example.test"


def test_resolve_testing_host_falls_back_without_staging_template(db_manager):
    # db_manager fixture использует TESTING_CONFIG без staging_host_template
    assert db_manager._resolve_testing_host("s2") == "s2-local.example.test"


def test_normalize_testing_config_requires_staging_host_template_placeholder(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        PROD_CONFIG,
        """
user: u
password: p
host_template: "{{env}}-local.example.test"
staging_host_template: "fixed-staging-host.example.test"
engines:
  pg11: { port: 15432, type: postgres }
services:
  crm: pg11
""",
    )

    assert manager.testing_config is None
    assert "staging_host_template должен содержать" in manager.testing_config_error


def test_staging_write_caution_present_for_write_query(tmp_path):
    manager = create_db_manager_with_config(tmp_path, PROD_CONFIG, TESTING_CONFIG_WITH_STAGING)
    result = manager.execute_query_direct("UPDATE crm SET x = 1", "crm", testing="s2")
    assert result.get("caution") is not None
    assert "не рекомендуется" in result["caution"]


def test_staging_write_caution_absent_for_select_query(tmp_path):
    manager = create_db_manager_with_config(tmp_path, PROD_CONFIG, TESTING_CONFIG_WITH_STAGING)
    result = manager.execute_query_direct("SELECT 1", "crm", testing="s2")
    assert "caution" not in result


def test_staging_write_caution_absent_for_non_staging_testing(db_manager):
    result = db_manager.execute_query_direct("UPDATE crm SET x = 1", "crm", testing=TESTING_ALPHA)
    assert "caution" not in result


def test_list_databases_caches_within_ttl(db_manager, monkeypatch):
    calls = {"count": 0}
    payload = {"prod_db": {"available": True}}

    def fake_fresh(testing=None):
        calls["count"] += 1
        return copy.deepcopy(payload)

    monkeypatch.setattr(db_manager, "_list_databases_fresh", fake_fresh)

    first = db_manager.list_databases()
    second = db_manager.list_databases()

    assert first == payload
    assert second == payload
    assert calls["count"] == 1


def test_list_databases_refetches_after_ttl(db_manager, monkeypatch):
    calls = {"count": 0}
    now = {"value": 1000.0}

    def fake_fresh(testing=None):
        calls["count"] += 1
        return {"prod_db": {"available": True, "generation": calls["count"]}}

    monkeypatch.setattr(db_manager, "LIST_DATABASES_TTL_SEC", 10)
    monkeypatch.setattr(mcp_db_server.time, "monotonic", lambda: now["value"])
    monkeypatch.setattr(db_manager, "_list_databases_fresh", fake_fresh)

    first = db_manager.list_databases()
    now["value"] += 11
    second = db_manager.list_databases()

    assert first["prod_db"]["generation"] == 1
    assert second["prod_db"]["generation"] == 2
    assert calls["count"] == 2


def test_list_databases_cache_keys_separate_prod_and_testing(db_manager, monkeypatch):
    calls = []

    def fake_fresh(testing=None):
        calls.append(testing)
        return {"key": testing or "prod"}

    monkeypatch.setattr(db_manager, "_list_databases_fresh", fake_fresh)

    assert db_manager.list_databases()["key"] == "prod"
    assert db_manager.list_databases(testing=TESTING_ALPHA)["key"] == TESTING_ALPHA
    assert db_manager.list_databases()["key"] == "prod"
    assert db_manager.list_databases(testing=TESTING_ALPHA)["key"] == TESTING_ALPHA
    assert calls == [None, TESTING_ALPHA]


def test_list_databases_cold_start_is_cache_miss(db_manager, monkeypatch):
    calls = {"count": 0}

    def fake_fresh(testing=None):
        calls["count"] += 1
        return {"prod_db": {"available": True}}

    monkeypatch.setattr(db_manager, "_list_databases_fresh", fake_fresh)

    assert db_manager._list_databases_cache == {}
    db_manager.list_databases()
    assert calls["count"] == 1
    assert "prod" in db_manager._list_databases_cache


def test_call_tool_runs_blocking_db_work_in_parallel(monkeypatch):
    barrier = threading.Barrier(2, timeout=1.0)
    state_lock = threading.Lock()
    active_calls = 0
    max_active_calls = 0

    def fake_execute_query(query, service, testing=None, timeout=None):
        nonlocal active_calls, max_active_calls
        with state_lock:
            active_calls += 1
            max_active_calls = max(max_active_calls, active_calls)

        try:
            barrier.wait()
            return {"success": True, "query": query}
        finally:
            with state_lock:
                active_calls -= 1

    monkeypatch.setenv("MCP_DB_MAX_CONCURRENT_TOOL_CALLS", "2")
    monkeypatch.setattr(mcp_db_server.db_manager, "execute_query_direct", fake_execute_query)

    async def run_calls():
        return await asyncio.gather(
            mcp_db_server.call_tool("execute_query", {"query": "SELECT 1", "service": "crm"}),
            mcp_db_server.call_tool("execute_query", {"query": "SELECT 2", "service": "crm"}),
        )

    results = asyncio.run(run_calls())

    assert [_tool_result_payload(result)["query"] for result in results] == ["SELECT 1", "SELECT 2"]
    assert max_active_calls == 2


def test_call_tool_respects_global_concurrency_limit(monkeypatch):
    state_lock = threading.Lock()
    active_calls = 0
    max_active_calls = 0

    def fake_execute_query(query, service, testing=None, timeout=None):
        nonlocal active_calls, max_active_calls
        with state_lock:
            active_calls += 1
            max_active_calls = max(max_active_calls, active_calls)

        try:
            time.sleep(0.05)
            return {"success": True, "query": query}
        finally:
            with state_lock:
                active_calls -= 1

    monkeypatch.setenv("MCP_DB_MAX_CONCURRENT_TOOL_CALLS", "1")
    monkeypatch.setattr(mcp_db_server.db_manager, "execute_query_direct", fake_execute_query)

    async def run_calls():
        return await asyncio.gather(
            mcp_db_server.call_tool("execute_query", {"query": "SELECT 1", "service": "crm"}),
            mcp_db_server.call_tool("execute_query", {"query": "SELECT 2", "service": "crm"}),
        )

    results = asyncio.run(run_calls())

    assert [_tool_result_payload(result)["query"] for result in results] == ["SELECT 1", "SELECT 2"]
    assert max_active_calls == 1
