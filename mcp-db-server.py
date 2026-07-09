#!/usr/bin/env python3
"""
MCP сервер для безопасной работы с базами данных Skyeng Platform
Поддерживает все предметы платформы с локальным хранением кредов
"""

import json
import logging
import os
import re
import hashlib
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional, Any, Union, Tuple
import asyncio
import yaml

import psycopg2
import psycopg2.extras
import pymysql
import pymysql.cursors
from mcp.server import Server
from mcp.types import (
    Resource, Tool, TextContent, CallToolRequest,
    ListResourcesRequest, ListToolsRequest, ReadResourceRequest
)
import mcp.server.stdio

# Настройка логирования
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('mcp-db-server.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 2
_tool_call_semaphore: Optional[asyncio.Semaphore] = None
_tool_call_semaphore_loop: Optional[asyncio.AbstractEventLoop] = None
_tool_call_semaphore_limit: Optional[int] = None


def _get_max_concurrent_tool_calls() -> int:
    raw_value = os.getenv("MCP_DB_MAX_CONCURRENT_TOOL_CALLS", str(DEFAULT_MAX_CONCURRENT_TOOL_CALLS))
    try:
        return max(1, int(raw_value))
    except ValueError:
        logger.warning(
            "Некорректный MCP_DB_MAX_CONCURRENT_TOOL_CALLS=%r, использую %s",
            raw_value,
            DEFAULT_MAX_CONCURRENT_TOOL_CALLS,
        )
        return DEFAULT_MAX_CONCURRENT_TOOL_CALLS


def _get_tool_call_semaphore() -> asyncio.Semaphore:
    global _tool_call_semaphore, _tool_call_semaphore_loop, _tool_call_semaphore_limit

    current_loop = asyncio.get_running_loop()
    current_limit = _get_max_concurrent_tool_calls()

    if (
        _tool_call_semaphore is None
        or _tool_call_semaphore_loop is not current_loop
        or _tool_call_semaphore_limit != current_limit
    ):
        _tool_call_semaphore = asyncio.Semaphore(current_limit)
        _tool_call_semaphore_loop = current_loop
        _tool_call_semaphore_limit = current_limit

    return _tool_call_semaphore


async def _run_db_tool_call(func, *args):
    # DB-драйверы синхронные; без выноса в thread они блокируют общий MCP event loop.
    async with _get_tool_call_semaphore():
        return await asyncio.to_thread(func, *args)

class DatabaseManager:
    """Менеджер для работы с базами данных предметов"""

    TESTING_ENV_PLACEHOLDER = "{{env}}"
    # Стейджинги именуются s2, s6, ... (без префикса test-); тестинги — test-yNN
    # или произвольные имена (test-alpha, my-env). См. .cursor/rules/glossary.mdc.
    STAGING_ENV_PATTERN = re.compile(r"^s\d+$")

    @staticmethod
    def _testing_port_missing_error(engine_name: str) -> str:
        return (
            "Прочитать данные с тестинга невозможно — "
            f"не указан port в .db-testing.yaml для engine «{engine_name}»"
        )

    @staticmethod
    def _testing_type_missing_error(engine_name: str) -> str:
        return (
            "Прочитать данные с тестинга невозможно — "
            f"не указан type в .db-testing.yaml для engine «{engine_name}»"
        )

    @staticmethod
    def _infer_db_type(host: str, port: int) -> str:
        """Определяет тип БД для prod: префикс хоста реплики или стандартные порты 3306/5432."""
        host_lower = host.lower()
        if host_lower.startswith("mysql-"):
            return "mysql"
        if host_lower.startswith("pgsql-"):
            return "postgres"

        standard_port_to_db_type = {
            3306: "mysql",
            5432: "postgres",
        }
        return standard_port_to_db_type.get(int(port), "postgres")

    def __init__(self, config_path: str = None, testing_config_path: str = None):
        script_dir = os.path.dirname(os.path.abspath(__file__))

        if config_path:
            self.config_path = config_path
        elif os.getenv("MCP_DB_CONFIG"):
            self.config_path = os.getenv("MCP_DB_CONFIG")
        else:
            self.config_path = os.path.join(script_dir, ".db.yaml")

        config_dir = os.path.dirname(os.path.abspath(self.config_path))
        if testing_config_path:
            self.testing_config_path = testing_config_path
        elif os.getenv("MCP_DB_TESTING_CONFIG"):
            self.testing_config_path = os.getenv("MCP_DB_TESTING_CONFIG")
        else:
            self.testing_config_path = os.path.join(config_dir, ".db-testing.yaml")

        self.connections: Dict[str, Dict] = {}
        self.testing_config: Optional[Dict[str, Any]] = None
        self.testing_config_error: Optional[str] = None
        self.schema_cache: Dict[str, Dict] = {}
        self.connect_timeout = int(os.getenv("MCP_DB_CONNECT_TIMEOUT", "2"))
        logger.info(f"Таймаут подключения к БД установлен: {self.connect_timeout} сек")
        self._load_db_config()

    def _load_db_config(self):
        """Загружает prod (.db.yaml) и тестинг (.db-testing.yaml)."""
        self._load_prod_config()
        self._load_testing_config()

    def _load_prod_config(self):
        """Загружает prod-реплики из .db.yaml."""
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                db_config = yaml.safe_load(f)

            if not isinstance(db_config, dict):
                raise ValueError("Конфигурация .db.yaml должна быть объектом")

            if "_testing" in db_config:
                raise ValueError(
                    "Секция _testing в .db.yaml больше не поддерживается. "
                    "Используйте отдельный файл .db-testing.yaml"
                )

            for db_name, db_info in db_config.items():
                normalized_config = self._normalize_prod_config_entry(db_name, db_info)

                if normalized_config:
                    self.connections[db_name] = normalized_config
                    logger.info(
                        f"Загружена конфигурация для БД: {db_name} "
                        f"({normalized_config['db_type']})"
                    )
                else:
                    logger.warning(f"Неполная конфигурация для БД {db_name}")

        except FileNotFoundError:
            logger.error(f"Файл конфигурации {self.config_path} не найден")
            raise
        except Exception as e:
            logger.error(f"Ошибка загрузки prod-конфигурации: {e}")
            raise

    def _load_testing_config(self):
        """Загружает тестинги из .db-testing.yaml (опционально)."""
        try:
            with open(self.testing_config_path, "r", encoding="utf-8") as f:
                testing_config = yaml.safe_load(f)

            if not isinstance(testing_config, dict):
                raise ValueError("Конфигурация .db-testing.yaml должна быть объектом")

            self.testing_config = self._normalize_testing_config(testing_config)
            logger.info(
                f"Загружен .db-testing.yaml: {len(self.testing_config['services'])} сервисов"
            )
        except FileNotFoundError:
            logger.warning(
                f"Файл тестинговой конфигурации {self.testing_config_path} не найден — "
                "режим testing недоступен"
            )
        except Exception as e:
            self.testing_config = None
            self.testing_config_error = str(e)
            logger.error(f"Ошибка загрузки тестинговой конфигурации: {e}")

    def _ensure_testing_available(self) -> None:
        if self.testing_config_error:
            raise ValueError(self.testing_config_error)
        if not self.testing_config:
            raise ValueError("Файл .db-testing.yaml не настроен")

    def _parse_legacy_db_config_entry(self, db_info: Dict[str, Any]) -> Dict[str, Any]:
        """Парсит старый формат конфига вида host:port и user:password."""
        host = None
        port = None
        user = None
        password = None
        reserved_keys = ["block_store", "host", "port", "user", "password", "type", "database"]

        for key, value in db_info.items():
            if isinstance(value, int) and key not in reserved_keys:
                host = key
                port = value
            elif isinstance(value, str) and key not in reserved_keys:
                user = key
                password = value

        return {
            "host": host,
            "port": port,
            "user": user,
            "password": password,
            "block_store": db_info.get("block_store"),
            "type": db_info.get("type"),
            "database": db_info.get("database"),
        }

    def _normalize_prod_config_entry(
        self,
        db_name: str,
        db_info: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """Нормализует prod-запись БД (legacy-формат host:port + user:password)."""
        if not isinstance(db_info, dict):
            raise ValueError(f"Некорректная конфигурация БД {db_name}: ожидается объект")

        legacy_config = self._parse_legacy_db_config_entry(db_info)

        resolved_config = {
            "host": db_info.get("host") or legacy_config.get("host"),
            "port": db_info.get("port") or legacy_config.get("port"),
            "user": db_info.get("user") or legacy_config.get("user"),
            "password": db_info.get("password") or legacy_config.get("password"),
            "block_store": db_info.get("block_store") or legacy_config.get("block_store"),
            "type": db_info.get("type") or legacy_config.get("type"),
            "database": db_info.get("database") or legacy_config.get("database"),
        }

        if not all([
            resolved_config.get("host"),
            resolved_config.get("port"),
            resolved_config.get("user"),
            resolved_config.get("password")
        ]):
            return None

        host = resolved_config["host"]
        port = int(resolved_config["port"])
        db_type = resolved_config.get("type") or self._infer_db_type(host, port)
        database = resolved_config.get("database") or db_name

        return {
            "host": host,
            "port": port,
            "database": database,
            "user": resolved_config["user"],
            "password": resolved_config["password"],
            "block_store": resolved_config.get("block_store"),
            "db_type": db_type,
        }

    def _normalize_testing_config(self, testing_info: Dict[str, Any]) -> Dict[str, Any]:
        """Нормализует содержимое .db-testing.yaml."""
        if not isinstance(testing_info, dict):
            raise ValueError("Конфигурация .db-testing.yaml должна быть объектом")

        required_fields = ["user", "password", "host_template", "engines", "services"]
        for field in required_fields:
            if field not in testing_info:
                raise ValueError(f"В .db-testing.yaml отсутствует обязательное поле {field}")

        if self.TESTING_ENV_PLACEHOLDER not in testing_info["host_template"]:
            raise ValueError(
                f"host_template должен содержать плейсхолдер {self.TESTING_ENV_PLACEHOLDER}"
            )

        staging_host_template = testing_info.get("staging_host_template")
        if staging_host_template and self.TESTING_ENV_PLACEHOLDER not in staging_host_template:
            raise ValueError(
                f"staging_host_template должен содержать плейсхолдер {self.TESTING_ENV_PLACEHOLDER}"
            )

        engines = testing_info["engines"]
        services = testing_info["services"]
        if not isinstance(engines, dict) or not engines:
            raise ValueError(".db-testing.yaml: engines должен быть непустым объектом")
        if not isinstance(services, dict) or not services:
            raise ValueError(".db-testing.yaml: services должен быть непустым объектом")

        normalized_engines: Dict[str, Dict[str, Any]] = {}
        for engine_name, engine_info in engines.items():
            port, db_type = self._resolve_testing_engine_port_and_type(engine_name, engine_info)
            normalized_engines[engine_name] = {
                "port": port,
                "type": db_type,
            }

        normalized_services: Dict[str, Dict[str, Any]] = {}
        for service_name, service_info in services.items():
            if isinstance(service_info, str):
                normalized_services[service_name] = {"engine": service_info}
                continue
            if not isinstance(service_info, dict) or "engine" not in service_info:
                raise ValueError(f"Некорректный сервис {service_name} в .db-testing.yaml")
            normalized_services[service_name] = dict(service_info)

        for service_name, service_info in normalized_services.items():
            engine_name = service_info["engine"]
            if engine_name not in normalized_engines:
                raise ValueError(
                    f"Сервис {service_name} ссылается на неизвестный engine {engine_name}"
                )

        return {
            "user": testing_info["user"],
            "password": testing_info["password"],
            "host_template": testing_info["host_template"],
            "staging_host_template": staging_host_template,
            "engines": normalized_engines,
            "services": normalized_services,
        }

    def _resolve_testing_engine_port_and_type(
        self,
        engine_name: str,
        engine_info: Any,
    ) -> Tuple[int, str]:
        """Порт и type для engine; оба обязательны в .db-testing.yaml."""
        if not isinstance(engine_info, dict):
            raise ValueError(f"Некорректный engine {engine_name} в .db-testing.yaml")

        if "port" not in engine_info or engine_info.get("port") is None:
            raise ValueError(self._testing_port_missing_error(engine_name))

        db_type = engine_info.get("type")
        if not db_type:
            raise ValueError(self._testing_type_missing_error(engine_name))

        try:
            port = int(engine_info["port"])
        except (TypeError, ValueError) as exc:
            raise ValueError(
                "Прочитать данные с тестинга невозможно — "
                f"некорректный port для engine «{engine_name}» в .db-testing.yaml: "
                f"{engine_info['port']!r}"
            ) from exc

        if db_type not in ("mysql", "postgres"):
            raise ValueError(
                "Прочитать данные с тестинга невозможно — "
                f"некорректный type для engine «{engine_name}» в .db-testing.yaml: "
                f"{db_type!r} (ожидается mysql или postgres)"
            )

        return port, db_type

    @staticmethod
    def _testing_env_suffix(testing: str) -> str:
        """test-alpha -> alpha; без префикса test- суффикс совпадает с testing."""
        if testing.startswith("test-"):
            return testing[len("test-"):]
        return testing

    @classmethod
    def _is_staging_env(cls, testing: str) -> bool:
        """Стейджинги именуются s2, s6, ... — отличаются от тестингов (test-yNN, my-env)."""
        return bool(cls.STAGING_ENV_PATTERN.match(testing))

    def _resolve_testing_host(self, testing: str) -> str:
        self._ensure_testing_available()
        staging_host_template = self.testing_config.get("staging_host_template")
        if staging_host_template and self._is_staging_env(testing):
            template = staging_host_template
        else:
            template = self.testing_config["host_template"]
        return template.replace(self.TESTING_ENV_PLACEHOLDER, testing)

    def _resolve_testing_connection(self, testing: str, service: str) -> Dict[str, Any]:
        """Собирает параметры подключения к БД на тестинге."""
        self._ensure_testing_available()

        service_info = self.testing_config["services"].get(service)
        if not service_info:
            raise ValueError(
                f"Сервис {service} не найден в .db-testing.yaml (services). "
                f"Добавьте его в конфиг или проверьте имя."
            )

        engine_name = service_info["engine"]
        engine = self.testing_config["engines"][engine_name]
        env_suffix = self._testing_env_suffix(testing)
        database = service_info.get("database") or f"{service}_auto_{env_suffix}"

        return {
            "host": self._resolve_testing_host(testing),
            "port": engine["port"],
            "database": database,
            "user": self.testing_config["user"],
            "password": self.testing_config["password"],
            "block_store": service_info.get("block_store"),
            "db_type": engine["type"],
            "engine": engine_name,
            "testing": testing,
            "service": service,
        }

    def _resolve_target(
        self,
        service: str,
        testing: Optional[str] = None,
    ) -> Tuple[str, Dict[str, Any]]:
        """Возвращает (логический_ключ, конфиг_подключения) для prod или тестинга."""
        if testing:
            conn = self._resolve_testing_connection(testing, service)
            return f"{service}@{testing}", conn

        if service not in self.connections:
            raise ValueError(f"БД {service} не найдена в конфигурации")

        return service, self.connections[service]

    def _is_write_allowed(self, testing: Optional[str] = None) -> bool:
        """На тестингах разрешены модифицирующие запросы."""
        return testing is not None

    def _validate_query(self, query: str, testing: Optional[str] = None) -> bool:
        """Валидирует SQL запрос - запрещены только модифицирующие операции (INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, GRANT, REVOKE, EXEC, EXECUTE)"""
        if self._is_write_allowed(testing):
            return True

        query_clean = re.sub(r'--.*$', '', query, flags=re.MULTILINE)
        query_clean = re.sub(r'/\*.*?\*/', '', query_clean, flags=re.DOTALL)
        query_clean = query_clean.strip().upper()

        # Разрешаем любые операции получения данных
        allowed_keywords = [
            'SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'VALUES'
        ]
        if not any(query_clean.startswith(keyword) for keyword in allowed_keywords):
            return False

        # Запрещаем любые модифицирующие операции только как отдельные слова (операторы)
        dangerous_keywords = [
            'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER',
            'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE'
        ]
        for dangerous in dangerous_keywords:
            # Ищем только целое слово (оператор), не подстроку
            if re.search(rf'\\b{dangerous}\\b', query_clean):
                return False
        return True

    @staticmethod
    def _looks_like_write_query(query: str) -> bool:
        """Эвристика для advisory-предупреждения: то же разбиение read/write, что и в _validate_query."""
        query_clean = re.sub(r'--.*$', '', query, flags=re.MULTILINE)
        query_clean = re.sub(r'/\*.*?\*/', '', query_clean, flags=re.DOTALL)
        query_clean = query_clean.strip().upper()
        read_keywords = ('SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'VALUES')
        return not query_clean.startswith(read_keywords)

    def _staging_write_caution(self, testing: Optional[str], query: str) -> Optional[str]:
        """Стейджинг технически не блокирует write (как и любой testing), но менять данные напрямую не рекомендуется."""
        if not testing or not self._is_staging_env(testing) or not self._looks_like_write_query(query):
            return None
        return (
            "Стейджинг: прямое изменение данных технически не блокируется (не опасно для прод-пользователей), "
            "но не рекомендуется без явной необходимости — предпочитай SELECT."
        )

    def _get_connection(self, logical_key: str, conn_config: Dict[str, Any]):
        """Получает подключение к БД по нормализованному конфигу."""
        db_type = conn_config.get("db_type", "postgres")

        try:
            if db_type == "mysql":
                conn = pymysql.connect(
                    host=conn_config["host"],
                    port=int(conn_config["port"]),
                    user=conn_config["user"],
                    password=conn_config["password"],
                    database=conn_config["database"],
                    connect_timeout=self.connect_timeout,
                    cursorclass=pymysql.cursors.DictCursor,
                )
            else:
                conn = psycopg2.connect(
                    host=conn_config["host"],
                    port=conn_config["port"],
                    database=conn_config["database"],
                    user=conn_config["user"],
                    password=conn_config["password"],
                    connect_timeout=self.connect_timeout
                )
            return conn
        except Exception as e:
            logger.error(f"Ошибка подключения к БД {logical_key}: {e}")
            raise

    def _cursor(self, conn, db_type: str):
        """Возвращает cursor context manager с dict-like строками."""
        if db_type == "mysql":
            return conn.cursor()
        return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def _connection_summary_queries(self, db_type: str) -> Tuple[str, str, str]:
        """SQL для list_databases / get_database_info: info, size, tables_count."""
        if db_type == "mysql":
            return (
                """
                SELECT
                    DATABASE() AS database_name,
                    CURRENT_USER() AS `current_user`,
                    VERSION() AS `version`
                """,
                """
                SELECT COALESCE(SUM(data_length + index_length), 0) as size_bytes
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                """,
                """
                SELECT COUNT(*) as tables_count
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                  AND table_type = 'BASE TABLE'
                """,
            )

        return (
            """
            SELECT
                current_database() as database_name,
                current_user as current_user,
                version() as version,
                pg_database_size(current_database()) as size_bytes
            """,
            "",
            """
            SELECT COUNT(*) as tables_count
            FROM information_schema.tables
            WHERE table_schema = 'public'
            """,
        )



    def _get_block_store_info(self, conn_config: Dict[str, Any]) -> Dict[str, str]:
        """Получает информацию о блок-сторе для указанной БД."""
        block_store_db = conn_config.get("block_store")
        if block_store_db:
            return {
                "block_store_database": block_store_db,
                "block_store_description": "Блок-стор - хранилище ответов пользователей на задания, содержит данные о прогрессе обучения и попытках решения задач"
            }

        return {}

    @staticmethod
    def _sql_dialect_hint(db_type: str) -> str:
        if db_type == "mysql":
            return (
                "MySQL: DATABASE(), USER() или CURRENT_USER() AS `current_user`, VERSION(); "
                "зарезервированные слова в алиасах — обратные кавычки"
            )
        return (
            "PostgreSQL: current_database(), current_user, version(); "
            "регистрозависимые идентификаторы — в двойных кавычках"
        )

    def _query_response_context(self, conn_config: Dict[str, Any]) -> Dict[str, Any]:
        db_type = conn_config.get("db_type", "postgres")
        context = {
            "db_type": db_type,
            "sql_dialect_hint": self._sql_dialect_hint(db_type),
        }
        if conn_config.get("engine"):
            context["engine"] = conn_config["engine"]
        return context

    def _connection_config_summary(self, conn_config: Dict[str, Any]) -> Dict[str, Any]:
        summary = {
            "host": conn_config["host"],
            "database": conn_config["database"],
            "user": conn_config["user"],
            "db_type": conn_config.get("db_type", "postgres"),
            "sql_dialect_hint": self._sql_dialect_hint(conn_config.get("db_type", "postgres")),
            "testing": conn_config.get("testing"),
            "service": conn_config.get("service"),
        }
        if conn_config.get("engine"):
            summary["engine"] = conn_config["engine"]
        return summary

    def _fetch_one_database_for_list(
        self,
        logical_key: str,
        conn_config: Dict[str, Any],
    ) -> Tuple[str, Dict]:
        """Собирает информацию по одной БД для list_databases (для вызова из пула потоков)."""
        db_type = conn_config.get("db_type", "postgres")
        try:
            with self._get_connection(logical_key, conn_config) as conn:
                with self._cursor(conn, db_type) as cur:
                    info_query, size_query, tables_query = self._connection_summary_queries(db_type)
                    cur.execute(info_query)
                    db_info = dict(cur.fetchone())

                    if size_query:
                        cur.execute(size_query)
                        db_info.update(dict(cur.fetchone()))

                    cur.execute(tables_query)
                    tables_info = dict(cur.fetchone())

                    entry = {
                        **db_info,
                        **tables_info,
                        "connection_config": self._connection_config_summary(conn_config),
                        "available": True,
                        **self._get_block_store_info(conn_config)
                    }
                    return (logical_key, entry)

        except Exception as e:
            entry = {
                "available": False,
                "error": str(e),
                "connection_config": self._connection_config_summary(conn_config),
                **self._get_block_store_info(conn_config)
            }
            return (logical_key, entry)

    def list_databases(self, testing: Optional[str] = None) -> Dict[str, Dict]:
        """Возвращает список БД с информацией (параллельные подключения)."""
        if testing:
            self._ensure_testing_available()

            targets = [
                (f"{service}@{testing}", self._resolve_testing_connection(testing, service))
                for service in self.testing_config["services"]
            ]
        else:
            targets = [
                (name, self.connections[name])
                for name in self.connections
            ]

        if not targets:
            return {}

        max_workers_env = os.getenv("MCP_DB_LIST_MAX_WORKERS")
        if max_workers_env:
            max_workers = max(1, int(max_workers_env))
        else:
            max_workers = min(16, len(targets))

        databases_info: Dict[str, Dict] = {}
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(self._fetch_one_database_for_list, key, config): key
                for key, config in targets
            }
            for future in as_completed(futures):
                logical_key, entry = future.result()
                databases_info[logical_key] = entry

        ordered_keys = [key for key, _ in targets]
        return {name: databases_info[name] for name in ordered_keys if name in databases_info}

    def execute_query_direct(
        self,
        query: str,
        service: str,
        testing: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Выполняет SQL запрос к БД напрямую."""
        if not self._validate_query(query, testing):
            raise ValueError("Запрос содержит недопустимые операции")

        start_time = time.time()
        try:
            logical_key, conn_config = self._resolve_target(service, testing)
        except ValueError as e:
            return {
                "success": False,
                "error": str(e),
                "service": service,
                "testing": testing,
                "execution_time": 0,
            }

        query_context = self._query_response_context(conn_config)
        db_type = conn_config.get("db_type", "postgres")
        caution = self._staging_write_caution(testing, query)

        try:
            with self._get_connection(logical_key, conn_config) as conn:
                with self._cursor(conn, db_type) as cur:
                    cur.execute(query)

                    if cur.description:
                        results = cur.fetchall()
                        results = [dict(row) for row in results]
                    else:
                        results = []

                    if db_type == "mysql" and self._is_write_allowed(testing):
                        conn.commit()

                    execution_time = time.time() - start_time

                    logger.info(f"Запрос к БД {logical_key} выполнен за {execution_time:.3f}с")

                    response = {
                        "success": True,
                        "data": results,
                        "rows_count": len(results),
                        "execution_time": execution_time,
                        "service": service,
                        "testing": testing,
                        "database": conn_config["database"],
                        **query_context,
                    }
                    if caution:
                        response["caution"] = caution
                    return response

        except Exception as e:
            logger.error(f"Ошибка выполнения запроса к БД {logical_key}: {e}")
            error_response = {
                "success": False,
                "error": str(e),
                "service": service,
                "testing": testing,
                "execution_time": time.time() - start_time,
                **query_context,
            }
            if caution:
                error_response["caution"] = caution
            return error_response


    def get_database_info_direct(
        self,
        service: str,
        testing: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Получает детальную информацию о БД напрямую."""
        try:
            logical_key, config = self._resolve_target(service, testing)
        except ValueError as e:
            return {
                "success": False,
                "error": str(e),
                "service": service,
                "testing": testing,
            }

        db_type = config.get("db_type", "postgres")

        try:
            with self._get_connection(logical_key, config) as conn:
                with self._cursor(conn, db_type) as cur:
                    info_query, size_query, tables_query = self._connection_summary_queries(db_type)
                    cur.execute(info_query)
                    db_info = dict(cur.fetchone())

                    if size_query:
                        cur.execute(size_query)
                        db_info.update(dict(cur.fetchone()))

                    if db_type == "mysql":
                        cur.execute("""
                        SELECT
                            table_name as tablename,
                            CONCAT(
                                ROUND((data_length + index_length) / 1024 / 1024, 2),
                                ' MB'
                            ) as size
                        FROM information_schema.tables
                        WHERE table_schema = DATABASE()
                          AND table_type = 'BASE TABLE'
                        ORDER BY (data_length + index_length) DESC
                        """)
                    else:
                        cur.execute("""
                        SELECT
                            tablename,
                            pg_size_pretty(pg_total_relation_size('public.'||tablename)) as size
                        FROM pg_tables
                        WHERE schemaname = 'public'
                        ORDER BY pg_total_relation_size('public.'||tablename) DESC
                        """)
                    tables = [dict(row) for row in cur.fetchall()]

                    return {
                        "success": True,
                        "service": service,
                        "testing": testing,
                        "database": config["database"],
                        "info": db_info,
                        "tables": tables,
                        "tables_count": len(tables),
                        "connection_config": self._connection_config_summary(config),
                        **self._get_block_store_info(config)
                    }

        except Exception as e:
            logger.error(f"Ошибка получения информации о БД {logical_key}: {e}")
            return {
                "success": False,
                "error": str(e),
                "service": service,
                "testing": testing,
                "connection_config": self._connection_config_summary(config),
                **self._get_block_store_info(config)
            }

    def get_tables_schemas_direct(
        self,
        service: str,
        testing: Optional[str] = None,
        table_names: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Получает схемы указанных таблиц или всех таблиц в БД."""
        try:
            logical_key, conn_config = self._resolve_target(service, testing)
        except ValueError as e:
            return {
                "success": False,
                "error": str(e),
                "service": service,
                "testing": testing,
            }

        db_type = conn_config.get("db_type", "postgres")

        try:
            with self._get_connection(logical_key, conn_config) as conn:
                with self._cursor(conn, db_type) as cur:
                    table_filter = ""
                    params = []
                    if table_names:
                        placeholders = ','.join(['%s'] * len(table_names))
                        table_filter = f" AND table_name IN ({placeholders})"
                        params.extend(table_names)

                    if db_type == "mysql":
                        schema_filter = "table_schema = DATABASE()"
                    else:
                        schema_filter = "table_schema = 'public'"

                    columns_query = f"""
                    SELECT
                        table_name,
                        column_name,
                        data_type,
                        is_nullable,
                        column_default,
                        character_maximum_length,
                        numeric_precision,
                        numeric_scale
                    FROM information_schema.columns
                    WHERE {schema_filter}{table_filter}
                    ORDER BY table_name, ordinal_position;
                    """
                    cur.execute(columns_query, params)
                    columns_data = cur.fetchall()

                    indexes_filter = ""
                    if table_names:
                        placeholders = ','.join(['%s'] * len(table_names))
                        if db_type == "mysql":
                            indexes_filter = f" AND table_name IN ({placeholders})"
                        else:
                            indexes_filter = f" AND tablename IN ({placeholders})"

                    if db_type == "mysql":
                        indexes_query = f"""
                        SELECT
                            table_name as tablename,
                            index_name as indexname,
                            CONCAT(
                                'INDEX ',
                                index_name,
                                ' (',
                                GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', '),
                                ')'
                            ) as indexdef
                        FROM information_schema.statistics
                        WHERE table_schema = DATABASE(){indexes_filter}
                        GROUP BY table_name, index_name
                        ORDER BY table_name, index_name;
                        """
                    else:
                        indexes_query = f"""
                        SELECT
                            tablename,
                            indexname,
                            indexdef
                        FROM pg_indexes
                        WHERE schemaname = 'public'{indexes_filter};
                        """
                    cur.execute(indexes_query, params if table_names else [])
                    indexes_data = cur.fetchall()

                    tables = {}
                    for row in columns_data:
                        table_name = row["table_name"]
                        if table_name not in tables:
                            tables[table_name] = {
                                "columns": [],
                                "indexes": []
                            }
                        tables[table_name]["columns"].append({
                            "column_name": row["column_name"],
                            "data_type": row["data_type"],
                            "is_nullable": row["is_nullable"],
                            "column_default": row["column_default"],
                            "character_maximum_length": row.get("character_maximum_length"),
                            "numeric_precision": row.get("numeric_precision"),
                            "numeric_scale": row.get("numeric_scale")
                        })

                    for row in indexes_data:
                        table_name = row["tablename"]
                        if table_name not in tables:
                            tables[table_name] = {
                                "columns": [],
                                "indexes": []
                            }
                        tables[table_name]["indexes"].append({
                            "indexname": row["indexname"],
                            "indexdef": row["indexdef"]
                        })

                    return {
                        "success": True,
                        "service": service,
                        "testing": testing,
                        "database": conn_config["database"],
                        "tables": tables,
                        "tables_count": len(tables),
                        "requested_tables": table_names
                    }

        except Exception as e:
            logger.error(f"Ошибка получения схем таблиц для БД {logical_key}: {e}")
            return {
                "success": False,
                "error": str(e),
                "service": service,
                "testing": testing,
                "requested_tables": table_names
            }

# Создаем экземпляр менеджера БД
db_manager = DatabaseManager()

MCP_SERVER_INSTRUCTIONS = """
MCP user-DB: prod-реплики и тестинги Skyeng Platform.

Параметры:
- service — имя сервиса/БД (crm, timetable, learning_groups_storage, …)
- testing — имя окружения для тестинга (my-env, test-alpha, …); без testing = prod (read-only)

Перед первым SQL к незнакомому service вызови get_database_info или list_databases и смотри connection_config.db_type.
SQL пиши в синтаксисе db_type из ответа; execute_query тоже возвращает db_type и sql_dialect_hint.

PostgreSQL (большинство сервисов, engines pg11/pg15/pg9):
- current_database(), current_user, version()
- SHOW TABLES нет — information_schema или get_tables_schemas

MySQL (например timetable → engine mysql8):
- DATABASE(), USER() или CURRENT_USER() AS `current_user`, VERSION()
- зарезервированные алиасы (current_user, order, …) — обратные кавычки

Безопасность: prod без testing — только SELECT/WITH/EXPLAIN; с testing — любые SQL.
Стейджинги (s2, s6, ...) — тот же параметр testing; технически запись разрешена и не опасна
для прод-пользователей, но прямое изменение данных на стейджинге не рекомендуется без явной
необходимости — предпочитай SELECT (см. caution в ответе execute_query при write-запросе).
Ошибка конфига тестинга (нет port и т.п.) — в error от execute_query, prod не затрагивается.
""".strip()

# Создаем MCP сервер
server = Server("mcp-db", instructions=MCP_SERVER_INSTRUCTIONS)

def _service_schema_description() -> str:
    return (
        "Имя сервиса/БД: для prod — ключ в .db.yaml (crm, learning_groups_storage); "
        "для тестинга — имя из .db-testing.yaml services (crm, trm, timetable)"
    )


def _testing_schema_description() -> str:
    return (
        "Имя тестинга/стейджинга (my-env, test-alpha, s2). "
        "При указании подключение строится из .db-testing.yaml. "
        "Стейджинги (s2, s6, ...) резолвятся через staging_host_template, если он задан; "
        "запись на стейджинг технически разрешена, но не рекомендуется без явной необходимости"
    )


@server.list_tools()
async def list_tools() -> list[Tool]:
    """Список доступных инструментов"""
    return [
        Tool(
            name="execute_query",
            description=(
                "Выполнить SQL к service [, testing]. Prod — read-only; testing — любые SQL. "
                "Ответ содержит db_type и sql_dialect_hint — используй их для синтаксиса. "
                "При syntax error пересобери запрос под db_type; для mysql не используй "
                "postgres-алиасы без обратных кавычек"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "SQL в диалекте db_type целевой БД. "
                            "Неизвестен db_type — сначала get_database_info(service[, testing])"
                        )
                    },
                    "service": {
                        "type": "string",
                        "description": _service_schema_description()
                    },
                    "testing": {
                        "type": "string",
                        "description": _testing_schema_description()
                    }
                },
                "required": ["query", "service"]
            }
        ),
        Tool(
            name="get_tables_schemas",
            description="Получить схемы указанных таблиц или всех таблиц в БД",
            inputSchema={
                "type": "object",
                "properties": {
                    "service": {
                        "type": "string",
                        "description": _service_schema_description()
                    },
                    "testing": {
                        "type": "string",
                        "description": _testing_schema_description()
                    },
                    "table_names": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Список названий таблиц (необязательно, если не указан - возвращает все таблицы)"
                    }
                },
                "required": ["service"]
            }
        ),
        Tool(
            name="list_databases",
            description=(
                "Список БД и статус подключения. Без testing — prod-реплики из .db.yaml; "
                "с testing — каталог services из .db-testing.yaml на указанном тестинге"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "testing": {
                        "type": "string",
                        "description": _testing_schema_description()
                    }
                }
            }
        ),
        Tool(
            name="get_database_info",
            description=(
                "Информация о БД: таблицы, размер, connection_config.db_type и sql_dialect_hint. "
                "Вызывай перед первым execute_query к новому service"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "service": {
                        "type": "string",
                        "description": _service_schema_description()
                    },
                    "testing": {
                        "type": "string",
                        "description": _testing_schema_description()
                    }
                },
                "required": ["service"]
            }
        ),

    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Обработка вызовов инструментов"""

    try:
        if name == "execute_query":
            query = arguments.get("query")
            service = arguments.get("service")
            testing = arguments.get("testing")

            if not query or not service:
                return [TextContent(
                    type="text",
                    text="Ошибка: необходимо указать query и service"
                )]

            result = await _run_db_tool_call(
                db_manager.execute_query_direct,
                query,
                service,
                testing,
            )
            return [TextContent(
                type="text",
                text=json.dumps(result, ensure_ascii=False, indent=2, default=str)
            )]

        elif name == "get_tables_schemas":
            service = arguments.get("service")
            testing = arguments.get("testing")
            table_names = arguments.get("table_names")

            if not service:
                return [TextContent(
                    type="text",
                    text="Ошибка: необходимо указать service"
                )]

            result = await _run_db_tool_call(
                db_manager.get_tables_schemas_direct,
                service,
                testing,
                table_names,
            )
            return [TextContent(
                type="text",
                text=json.dumps(result, ensure_ascii=False, indent=2, default=str)
            )]

        elif name == "list_databases":
            testing = arguments.get("testing")
            result = await _run_db_tool_call(db_manager.list_databases, testing)
            return [TextContent(
                type="text",
                text=json.dumps(result, ensure_ascii=False, indent=2, default=str)
            )]

        elif name == "get_database_info":
            service = arguments.get("service")
            testing = arguments.get("testing")

            if not service:
                return [TextContent(
                    type="text",
                    text="Ошибка: необходимо указать service"
                )]

            result = await _run_db_tool_call(
                db_manager.get_database_info_direct,
                service,
                testing,
            )
            return [TextContent(
                type="text",
                text=json.dumps(result, ensure_ascii=False, indent=2, default=str)
            )]


        else:
            return [TextContent(
                type="text",
                text=f"Неизвестный инструмент: {name}"
            )]

    except Exception as e:
        logger.error(f"Ошибка выполнения инструмента {name}: {e}")
        return [TextContent(
            type="text",
            text=f"Ошибка: {str(e)}"
        )]

def show_help():
    """Показать справку"""
    print("MCP сервер для работы с БД Skyeng Platform\n")
    print("Использование:")
    print("  ./mcp-server                  - Запуск MCP сервера")
    print("  ./mcp-server --help           - Показать эту справку")
    print("  ./mcp-server --list-databases [my-env] - Prod или каталог тестинга")
    print("  ./mcp-server --test [my-env]           - Проверить подключения\n")
    print("Доступные инструменты MCP:")
    print("  • execute_query         - SQL к prod (service) или тестингу (service + testing)")
    print("  • get_tables_schemas    - Схемы таблиц (service [, testing])")
    print("  • list_databases        - Prod-реплики или каталог тестинга (list_databases + testing)")
    print("  • get_database_info     - Детальная информация о БД (service [, testing])\n")
    print("Конфигурация:")
    print("  .db.yaml         — prod-реплики (по умолчанию рядом с mcp-db-server.py)")
    print("  .db-testing.yaml — тестинги (рядом с .db.yaml)")
    print("  MCP_DB_CONFIG=/path/to/.db.yaml — prod-конфиг")
    print("  MCP_DB_TESTING_CONFIG=/path/to/.db-testing.yaml — тестинг-конфиг")
    print("  MCP_DB_MAX_CONCURRENT_TOOL_CALLS=2 — лимит одновременных DB tool calls")

async def main():
    """Запуск MCP сервера"""
    import sys

    # Обработка аргументов командной строки
    if len(sys.argv) > 1:
        arg = sys.argv[1]

        if arg in ['--help', '-h']:
            show_help()
            return

        elif arg == '--list-databases':
            testing = sys.argv[2] if len(sys.argv) > 2 else None
            try:
                databases = db_manager.list_databases(testing)
                label = f"тестинг {testing}" if testing else "prod"
                print(f"Доступные базы данных ({label}):")
                for db_name, info in databases.items():
                    status = "✅" if info.get("available", False) else "❌"
                    print(f"  {status} {db_name}")
                    if info.get("available", False):
                        config = info["connection_config"]
                        print(f"      └─ {config['host']} / {config['database']}")
                    else:
                        print(f"      └─ Ошибка: {info.get('error', 'Неизвестная ошибка')}")
                print(f"\nВсего: {len(databases)}")
            except Exception as e:
                print(f"Ошибка: {e}")
            return
        elif arg == '--test':
            testing = sys.argv[2] if len(sys.argv) > 2 else None
            try:
                label = f"тестинг {testing}" if testing else "prod"
                print(f"🔍 Тестирование подключений ({label})...")
                databases = db_manager.list_databases(testing)
                working_count = 0
                for db_name, info in databases.items():
                    status = "✅" if info.get("available", False) else "❌"
                    print(f"  {status} {db_name}")
                    if info.get("available", False):
                        working_count += 1
                        config = info["connection_config"]
                        print(f"      └─ {config['host']} / {config['database']}")
                    else:
                        print(f"      └─ Ошибка: {info.get('error', 'Неизвестная ошибка')}")
                print(f"\n📊 Результат: {working_count}/{len(databases)} подключений работают")
            except Exception as e:
                print(f"Ошибка: {e}")
            return
        else:
            print(f"Неизвестный аргумент: {arg}")
            print("Используйте --help для справки")
            return

    # Запуск MCP сервера
    logger.info("Запуск MCP сервера для работы с БД Skyeng Platform")

    # Проверяем доступные БД при запуске
    try:
        available_dbs = list(db_manager.connections.keys())
        logger.info(f"Загружено БД: {len(available_dbs)}")
    except Exception as e:
        logger.error(f"Ошибка при проверке доступных БД: {e}")

    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )

if __name__ == "__main__":
    asyncio.run(main())