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

class DatabaseManager:
    """Менеджер для работы с базами данных предметов"""

    WRITE_ALLOWED_DATABASE_PATTERN = re.compile(r"_auto_\w\d+$")

    @staticmethod
    def _infer_db_type(host: str, port: int) -> str:
        """Определяет тип БД: префикс хоста для реплик, порт для тестингов."""
        host_lower = host.lower()
        if host_lower.startswith("mysql-"):
            return "mysql"
        if host_lower.startswith("pgsql-"):
            return "postgres"

        port_to_db_type = {
            3306: "mysql",    # mysql8 на тестинге
            5432: "postgres",  # pg11
            5532: "postgres",  # pg15
        }
        return port_to_db_type.get(int(port), "postgres")

    def __init__(self, config_path: str = None):
        # Получаем директорию скрипта
        script_dir = os.path.dirname(os.path.abspath(__file__))

        # Приоритет поиска конфигурации:
        # 1. Параметр config_path
        # 2. Переменная окружения MCP_DB_CONFIG
        # 3. Локальный .db.yaml рядом с сервером
        if config_path:
            self.config_path = config_path
        elif os.getenv("MCP_DB_CONFIG"):
            self.config_path = os.getenv("MCP_DB_CONFIG")
        else:
            self.config_path = os.path.join(script_dir, ".db.yaml")
        self.connections: Dict[str, Dict] = {}
        self.schema_cache: Dict[str, Dict] = {}
        # Таймаут подключения (секунды), можно переопределить через MCP_DB_CONNECT_TIMEOUT
        self.connect_timeout = int(os.getenv("MCP_DB_CONNECT_TIMEOUT", "2"))
        logger.info(f"Таймаут подключения к БД установлен: {self.connect_timeout} сек")
        self._load_db_config()

    def _load_db_config(self):
        """Загружает конфигурацию подключений к БД"""
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                db_config = yaml.safe_load(f)

            templates = db_config.get("_templates", {}) if isinstance(db_config, dict) else {}

            # ключи это названия БД
            for db_name, db_info in db_config.items():
                if db_name == "_templates":
                    continue

                normalized_config = self._normalize_db_config_entry(db_name, db_info, templates)

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
            logger.error(f"Ошибка загрузки конфигурации: {e}")
            raise

    def _parse_legacy_db_config_entry(self, db_info: Dict[str, Any]) -> Dict[str, Any]:
        """Парсит старый формат конфига вида host:port и user:password."""
        host = None
        port = None
        user = None
        password = None
        reserved_keys = ["block_store", "template", "host", "port", "user", "password", "type", "database"]

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

    def _normalize_db_config_entry(
        self,
        db_name: str,
        db_info: Dict[str, Any],
        templates: Dict[str, Dict[str, Any]]
    ) -> Optional[Dict[str, Any]]:
        """Нормализует запись БД из старого или шаблонного формата."""
        if not isinstance(db_info, dict):
            raise ValueError(f"Некорректная конфигурация БД {db_name}: ожидается объект")

        template_name = db_info.get("template")
        template_config = {}
        if template_name:
            template_config = templates.get(template_name)
            if not isinstance(template_config, dict):
                raise ValueError(f"Шаблон {template_name} для БД {db_name} не найден")

        legacy_config = self._parse_legacy_db_config_entry(db_info)

        def pick_config_value(field_name: str):
            direct_value = db_info.get(field_name)
            if direct_value is not None:
                return direct_value

            legacy_value = legacy_config.get(field_name)
            if legacy_value is not None:
                return legacy_value

            return template_config.get(field_name)

        resolved_config = {
            **template_config,
            **legacy_config,
            "host": pick_config_value("host"),
            "port": pick_config_value("port"),
            "user": pick_config_value("user"),
            "password": pick_config_value("password"),
            "block_store": pick_config_value("block_store"),
            "type": pick_config_value("type"),
            "database": pick_config_value("database"),
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
            "port": resolved_config["port"],
            "database": database,
            "user": resolved_config["user"],
            "password": resolved_config["password"],
            "block_store": resolved_config.get("block_store"),
            "db_type": db_type,
        }



    def _is_write_allowed_database(self, database: str) -> bool:
        """Определяет тестовые БД, где разрешены модифицирующие запросы."""
        return bool(self.WRITE_ALLOWED_DATABASE_PATTERN.search(database))

    def _validate_query(self, query: str, database: str = "") -> bool:
        """Валидирует SQL запрос - запрещены только модифицирующие операции (INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, GRANT, REVOKE, EXEC, EXECUTE)"""
        if self._is_write_allowed_database(database):
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

    def _get_connection(self, db_name: str):
        """Получает подключение к БД"""
        if db_name not in self.connections:
            raise ValueError(f"БД {db_name} не найдена в конфигурации")

        conn_config = self.connections[db_name]
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
            logger.error(f"Ошибка подключения к БД {db_name}: {e}")
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
                    DATABASE() as database_name,
                    CURRENT_USER() as current_user,
                    VERSION() as version
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



    def _get_block_store_info(self, db_name: str) -> Dict[str, str]:
        """Получает информацию о блок-сторе для указанной БД"""
        connection_config = self.connections.get(db_name, {})
        block_store_db = connection_config.get("block_store")
        if block_store_db:
            return {
                "block_store_database": block_store_db,
                "block_store_description": "Блок-стор - хранилище ответов пользователей на задания, содержит данные о прогрессе обучения и попытках решения задач"
            }

        return {}

    def _fetch_one_database_for_list(self, db_name: str) -> Tuple[str, Dict]:
        """Собирает информацию по одной БД для list_databases (для вызова из пула потоков)."""
        config = self.connections[db_name]
        db_type = config.get("db_type", "postgres")
        try:
            with self._get_connection(db_name) as conn:
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
                        "connection_config": {
                            "host": config["host"],
                            "database": config["database"],
                            "user": config["user"],
                            "db_type": db_type,
                        },
                        "available": True,
                        **self._get_block_store_info(db_name)
                    }
                    return (db_name, entry)

        except Exception as e:
            entry = {
                "available": False,
                "error": str(e),
                "connection_config": {
                    "host": config["host"],
                    "database": config["database"],
                    "user": config["user"],
                    "db_type": db_type,
                },
                **self._get_block_store_info(db_name)
            }
            return (db_name, entry)

    def list_databases(self) -> Dict[str, Dict]:
        """Возвращает список всех БД с информацией (параллельные подключения)."""
        db_names = list(self.connections.keys())
        if not db_names:
            return {}

        max_workers_env = os.getenv("MCP_DB_LIST_MAX_WORKERS")
        if max_workers_env:
            max_workers = max(1, int(max_workers_env))
        else:
            max_workers = min(16, len(db_names))

        databases_info: Dict[str, Dict] = {}
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(self._fetch_one_database_for_list, name): name
                for name in db_names
            }
            for future in as_completed(futures):
                db_name, entry = future.result()
                databases_info[db_name] = entry

        # Порядок ключей как в конфиге (а не порядок завершения запросов)
        return {name: databases_info[name] for name in db_names}

    def execute_query_direct(self, query: str, database: str) -> Dict[str, Any]:
        """Выполняет SQL запрос к БД напрямую"""
        if not self._validate_query(query, database):
            raise ValueError("Запрос содержит недопустимые операции")

        if database not in self.connections:
            return {
                "success": False,
                "error": f"БД {database} не найдена в конфигурации",
                "database": database,
                "execution_time": 0
            }

        start_time = time.time()
        db_type = self.connections[database].get("db_type", "postgres")

        try:
            with self._get_connection(database) as conn:
                with self._cursor(conn, db_type) as cur:
                    cur.execute(query)

                    if cur.description:
                        results = cur.fetchall()
                        results = [dict(row) for row in results]
                    else:
                        results = []

                    if db_type == "mysql" and self._is_write_allowed_database(database):
                        conn.commit()

                    execution_time = time.time() - start_time

                    logger.info(f"Запрос к БД {database} выполнен за {execution_time:.3f}с")

                    return {
                        "success": True,
                        "data": results,
                        "rows_count": len(results),
                        "execution_time": execution_time,
                        "database": database
                    }

        except Exception as e:
            logger.error(f"Ошибка выполнения запроса к БД {database}: {e}")
            return {
                "success": False,
                "error": str(e),
                "database": database,
                "execution_time": time.time() - start_time
            }


    def get_database_info_direct(self, database: str) -> Dict[str, Any]:
        """Получает детальную информацию о БД напрямую"""
        if database not in self.connections:
            return {
                "success": False,
                "error": f"БД {database} не найдена в конфигурации",
                "database": database
            }

        config = self.connections[database]
        db_type = config.get("db_type", "postgres")

        try:
            with self._get_connection(database) as conn:
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
                        "database": database,
                        "info": db_info,
                        "tables": tables,
                        "tables_count": len(tables),
                        "connection_config": {
                            "host": config["host"],
                            "database": config["database"],
                            "user": config["user"],
                            "db_type": db_type,
                        },
                        **self._get_block_store_info(database)
                    }

        except Exception as e:
            logger.error(f"Ошибка получения информации о БД {database}: {e}")
            return {
                "success": False,
                "error": str(e),
                "database": database,
                "connection_config": {
                    "host": config["host"],
                    "database": config["database"],
                    "user": config["user"],
                    "db_type": db_type,
                },
                **self._get_block_store_info(database)
            }
    def get_tables_schemas_direct(self, database: str, table_names: Optional[List[str]] = None) -> Dict[str, Any]:
        """Получает схемы указанных таблиц или всех таблиц в БД"""
        if database not in self.connections:
            return {
                "success": False,
                "error": f"БД {database} не найдена в конфигурации",
                "database": database
            }

        db_type = self.connections[database].get("db_type", "postgres")

        try:
            with self._get_connection(database) as conn:
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
                        "database": database,
                        "tables": tables,
                        "tables_count": len(tables),
                        "requested_tables": table_names
                    }

        except Exception as e:
            logger.error(f"Ошибка получения схем таблиц для БД {database}: {e}")
            return {
                "success": False,
                "error": str(e),
                "database": database,
                "requested_tables": table_names
            }

# Создаем экземпляр менеджера БД
db_manager = DatabaseManager()

# Создаем MCP сервер
server = Server("mcp-db")

@server.list_tools()
async def list_tools() -> list[Tool]:
    """Список доступных инструментов"""
    return [
        Tool(
            name="execute_query",
            description="Выполнить SQL запрос к БД. Для обычных БД разрешено только чтение; для ключей конфига *_auto_<env> — любые запросы",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "SQL запрос. Для обычных БД только SELECT, WITH, EXPLAIN; для ключей конфига *_auto_y10/*_auto_s2 — любые запросы"
                    },
                    "database": {
                        "type": "string",
                        "description": "Ключ записи в .db.yaml (не имя БД на сервере из поля database)"
                    }
                },
                "required": ["query", "database"]
            }
        ),
        Tool(
            name="get_tables_schemas",
            description="Получить схемы указанных таблиц или всех таблиц в БД",
            inputSchema={
                "type": "object",
                "properties": {
                    "database": {
                        "type": "string",
                        "description": "Ключ записи в .db.yaml"
                    },
                    "table_names": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Список названий таблиц (необязательно, если не указан - возвращает все таблицы)"
                    }
                },
                "required": ["database"]
            }
        ),
        Tool(
            name="list_databases",
            description="Получить список всех доступных БД",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="get_database_info",
            description="Получить детальную информацию о БД",
            inputSchema={
                "type": "object",
                "properties": {
                    "database": {
                        "type": "string",
                        "description": "Ключ записи в .db.yaml"
                    }
                },
                "required": ["database"]
            }
        ),

    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Обработка вызовов инструментов"""

    try:
        if name == "execute_query":
            query = arguments.get("query")
            database = arguments.get("database")

            if not query or not database:
                return [TextContent(
                    type="text",
                    text="Ошибка: необходимо указать query и database"
                )]

            result = db_manager.execute_query_direct(query, database)
            return [TextContent(
                type="text",
                text=json.dumps(result, ensure_ascii=False, indent=2, default=str)
            )]

        elif name == "get_tables_schemas":
            database = arguments.get("database")
            table_names = arguments.get("table_names")

            if not database:
                return [TextContent(
                    type="text",
                    text="Ошибка: необходимо указать database"
                )]

            result = db_manager.get_tables_schemas_direct(database, table_names)
            return [TextContent(
                type="text",
                text=json.dumps(result, ensure_ascii=False, indent=2, default=str)
            )]

        elif name == "list_databases":
            result = db_manager.list_databases()
            return [TextContent(
                type="text",
                text=json.dumps(result, ensure_ascii=False, indent=2, default=str)
            )]

        elif name == "get_database_info":
            database = arguments.get("database")

            if not database:
                return [TextContent(
                    type="text",
                    text="Ошибка: необходимо указать database"
                )]

            result = db_manager.get_database_info_direct(database)
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
    print("  ./mcp-server --list-databases - Показать все БД и статус подключения")
    print("  ./mcp-server --test           - Проверить подключения ко всем БД\n")
    print("Доступные инструменты MCP:")
    print("  • execute_query         - Выполнить SQL запрос к БД; для *_auto_y10/*_auto_s2 и подобных тестовых БД разрешены любые запросы")
    print("  • get_tables_schemas    - Получить схемы указанных таблиц или всех таблиц в БД")
    print("  • list_databases        - Список всех доступных БД и их статус")
    print("  • get_database_info     - Детальная информация о БД (размер, таблицы)\n")
    print("Конфигурация:")
    print("  .db.yaml рядом с mcp-db-server.py — настройки подключений к БД (по умолчанию)")
    print("  MCP_DB_CONFIG=/absolute/path/to/.db.yaml — переопределить путь к конфигу")

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
            try:
                databases = db_manager.list_databases()
                print("Доступные базы данных:")
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
            try:
                print("🔍 Тестирование подключений...")
                databases = db_manager.list_databases()
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