import pytest
import importlib.util
import sys
import textwrap

# Фиктивные хосты для тестов конфигурации (не prod/test инфраструктура).
MYSQL_REPL_HOST = "mysql-example-repl.example.test"
PGSQL_REPL_HOST = "pgsql-example-repl.example.test"
TEST_ENV_HOST = "test-env-local.example.test"
LEGACY_HOST = "legacy-host.example.test"

# Импортируем DatabaseManager из файла с дефисом в имени
spec = importlib.util.spec_from_file_location("mcp_db_server", "./mcp-db-server.py")
mcp_db_server = importlib.util.module_from_spec(spec)
sys.modules["mcp_db_server"] = mcp_db_server
spec.loader.exec_module(mcp_db_server)
DatabaseManager = mcp_db_server.DatabaseManager

@pytest.fixture
def db_manager():
    # Можно передать фиктивный путь, т.к. для теста нужен только _validate_query
    return DatabaseManager(config_path=None)


def create_db_manager_with_config(tmp_path, config_text):
    config_path = tmp_path / "db.yaml"
    config_path.write_text(textwrap.dedent(config_text), encoding="utf-8")
    return DatabaseManager(config_path=str(config_path))

def test_validate_query_allows_complex_select(db_manager):
    query = '''
    SELECT 
        r.hash,
        r.name,
        r.type,
        r.status,
        r.created_at,
        r.started_at,
        r.closed_at,
        lm.id as lesson_material_id,
        lm.name as lesson_material_name
    FROM room r
    JOIN room_participant rp ON rp.room_id = r.id
    JOIN lesson_material lm ON lm.id = rp.current_material_id
    WHERE r.hash IN ('bufadurelapu', 'zalevemaruzi', 'febefabagafo', 'vuvelevevela')
    ORDER BY r.started_at, lm.id;
    '''
    assert db_manager._validate_query(query) is True

    query = "SELECT \n    r.hash,\n    r.name,\n    r.type,\n    r.status,\n    r.created_at,\n    r.started_at,\n    r.closed_at,\n    lm.id as lesson_material_id,\n    lm.name as lesson_material_name\nFROM room r\nJOIN room_participant rp ON rp.room_id = r.id\nJOIN lesson_material lm ON lm.id = rp.current_material_id\nWHERE r.hash IN ('bufadurelapu', 'zalevemaruzi', 'febefabagafo', 'vuvelevevela')\nORDER BY r.started_at, lm.id;"

    assert db_manager._validate_query(query) is True 


def test_validate_query_blocks_write_for_regular_database(db_manager):
    query = "UPDATE users SET name = 'test' WHERE id = 1"

    assert db_manager._validate_query(query, "skysmart_english") is False


@pytest.mark.parametrize(
    ("database_name", "query"),
    [
        ("teacher_catalog_auto_y10", "UPDATE teachers SET name = 'test' WHERE id = 1"),
        ("skysmart_english_auto_y44", "DELETE FROM users WHERE id = 1"),
        ("skysmart_english_auto_s2", "INSERT INTO users(id) VALUES (1)"),
    ],
)
def test_validate_query_allows_any_query_for_auto_databases(db_manager, database_name, query):
    assert db_manager._validate_query(query, database_name) is True


@pytest.mark.parametrize(
    ("database_name", "expected"),
    [
        ("teacher_catalog_auto_y10", True),
        ("skysmart_english_auto_y44", True),
        ("skysmart_english_auto_s2", True),
        ("skysmart_english", False),
        ("teacher_catalog_auto", False),
        ("teacher_catalog_auto_prod", False),
    ],
)
def test_is_write_allowed_database(db_manager, database_name, expected):
    assert db_manager._is_write_allowed_database(database_name) is expected


def test_load_db_config_supports_legacy_format(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        f"""
        legacy_db:
          {LEGACY_HOST}: 5432
          legacy_user: secret
          block_store: legacy_block_store
        """
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


def test_load_db_config_supports_templates_and_overrides(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        f"""
        _templates:
          test_y10_pg11:
            host: {TEST_ENV_HOST}
            port: 5432
            user: ya_testing
            password: secret
            block_store: common_block_store

        skysmart_english_auto_y10:
          template: test_y10_pg11

        teacher_catalog_auto_y10:
          template: test_y10_pg11
          port: 5532
          block_store: custom_block_store
        """
    )

    assert manager.connections["skysmart_english_auto_y10"] == {
        "host": TEST_ENV_HOST,
        "port": 5432,
        "database": "skysmart_english_auto_y10",
        "user": "ya_testing",
        "password": "secret",
        "block_store": "common_block_store",
        "db_type": "postgres",
    }
    assert manager.connections["teacher_catalog_auto_y10"] == {
        "host": TEST_ENV_HOST,
        "port": 5532,
        "database": "teacher_catalog_auto_y10",
        "user": "ya_testing",
        "password": "secret",
        "block_store": "custom_block_store",
        "db_type": "postgres",
    }


def test_load_db_config_raises_for_unknown_template(tmp_path):
    config_path = tmp_path / "db.yaml"
    config_path.write_text(
        textwrap.dedent(
            """
            broken_db:
              template: missing_template
            """
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="Шаблон missing_template для БД broken_db не найден"):
        DatabaseManager(config_path=str(config_path))


@pytest.mark.parametrize(
    ("host", "port", "expected"),
    [
        (MYSQL_REPL_HOST, 3306, "mysql"),
        (PGSQL_REPL_HOST, 5432, "postgres"),
        (LEGACY_HOST, 5432, "postgres"),
        (TEST_ENV_HOST, 3306, "mysql"),
        (TEST_ENV_HOST, 5432, "postgres"),
        (TEST_ENV_HOST, 5532, "postgres"),
    ],
)
def test_infer_db_type(host, port, expected):
    assert DatabaseManager._infer_db_type(host, port) == expected


def test_load_db_config_detects_db_type_from_host_prefix(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        f"""
        timetable:
          {MYSQL_REPL_HOST}: 3306
          ro_user: secret

        student_vacation:
          {PGSQL_REPL_HOST}: 5432
          ro_user: secret
        """
    )

    assert manager.connections["timetable"]["db_type"] == "mysql"
    assert manager.connections["student_vacation"]["db_type"] == "postgres"


def test_load_db_config_detects_db_type_from_port_on_testing(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        f"""
        _templates:
          test_mysql8:
            host: {TEST_ENV_HOST}
            port: 3306
            user: ya_testing
            password: secret
          test_pg11:
            host: {TEST_ENV_HOST}
            port: 5432
            user: ya_testing
            password: secret
          test_pg15:
            host: {TEST_ENV_HOST}
            port: 5532
            user: ya_testing
            password: secret

        timetable_auto_y10:
          template: test_mysql8
        crm_auto_y10:
          template: test_pg15
        trm_auto_y10:
          template: test_pg11
        """
    )

    assert manager.connections["timetable_auto_y10"]["db_type"] == "mysql"
    assert manager.connections["crm_auto_y10"]["db_type"] == "postgres"
    assert manager.connections["trm_auto_y10"]["db_type"] == "postgres"


def test_load_db_config_supports_database_name_override(tmp_path):
    manager = create_db_manager_with_config(
        tmp_path,
        f"""
        _templates:
          test_mysql8:
            host: {TEST_ENV_HOST}
            port: 3306
            user: ya_testing
            password: secret

        timetable_auto_y10:
          template: test_mysql8
          database: timetable

        timetable:
          {MYSQL_REPL_HOST}: 3306
          ro_user: secret
          database: timetable
        """
    )

    assert manager.connections["timetable_auto_y10"]["database"] == "timetable"
    assert manager.connections["timetable"]["database"] == "timetable"


def test_connection_summary_queries_mysql_quotes_reserved_aliases(db_manager):
    info_query, size_query, tables_query = db_manager._connection_summary_queries("mysql")

    assert "CURRENT_USER() AS `current_user`" in info_query
    assert "VERSION() AS `version`" in info_query
    assert "information_schema.tables" in size_query
    assert "information_schema.tables" in tables_query


def test_connection_summary_queries_postgres_unchanged(db_manager):
    info_query, size_query, tables_query = db_manager._connection_summary_queries("postgres")

    assert "current_user as current_user" in info_query
    assert size_query == ""
    assert "information_schema.tables" in tables_query