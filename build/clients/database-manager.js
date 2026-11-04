import * as path from "path";
import { loadProdConfig, loadTestingConfig, } from "../utils/config.js";
import { connectTimeoutSec, listMaxWorkers, listProbeEnabled, normalizeQueryTimeoutSec, testingOnly, } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import { isQueryTimeoutError, stagingWriteCaution, validateQuery } from "../utils/query-guard.js";
import { mapWithConcurrency } from "../utils/semaphore.js";
import { columnsQuery, connectionSummaryQueries, indexesQuery, sqlDialectHint, tablesBySizeQuery, } from "../utils/sql.js";
import { coerceTesting, isStagingEnv, normalizeTestingEnv, TESTING_ENV_PLACEHOLDER, testingEnvSuffix, } from "../utils/testing-env.js";
import { runSession } from "./db-session.js";
export const LIST_DATABASES_TTL_MS = 10 * 60 * 1000;
const TESTING_ONLY_PROD_ERROR = "БД не найдена: mcp-db-testing не открывает prod. Передай testing или задай TESTING_NAME";
const TESTING_ONLY_LIST_ERROR = "list_databases: mcp-db-testing не открывает prod. Передай testing или задай TESTING_NAME";
const BLOCK_STORE_DESCRIPTION = "Блок-стор - хранилище ответов пользователей на задания, содержит данные о прогрессе обучения и попытках решения задач";
const errorMessage = (error) => error instanceof Error ? error.message : String(error);
const isProdConnection = (conn) => !conn.testing;
export class DatabaseManager {
    constructor(options = {}) {
        this.testingConfig = null;
        this.testingConfigError = null;
        this.listDatabasesTtlMs = LIST_DATABASES_TTL_MS;
        this.listDatabasesCache = new Map();
        const defaultDir = options.defaultConfigDir ?? process.cwd();
        this.configPath = options.configPath || process.env.MCP_DB_CONFIG || path.join(defaultDir, ".db.yaml");
        this.testingConfigPath =
            options.testingConfigPath ||
                process.env.MCP_DB_TESTING_CONFIG ||
                path.join(path.dirname(path.resolve(this.configPath)), ".db-testing.yaml");
        this.runSession = options.runSession ?? runSession;
        this.now = options.now ?? (() => performance.now());
        this.connections = loadProdConfig(this.configPath);
        for (const [name, conn] of Object.entries(this.connections)) {
            logger.info(`Загружена конфигурация для БД: ${name} (${conn.db_type})`);
        }
        const testing = loadTestingConfig(this.testingConfigPath);
        if (testing.status === "loaded") {
            this.testingConfig = testing.config;
            logger.info(`Загружен .db-testing.yaml: ${Object.keys(testing.config.services).length} сервисов`);
        }
        else if (testing.status === "missing") {
            logger.warn(`Файл тестинговой конфигурации ${this.testingConfigPath} не найден — режим testing недоступен`);
        }
        else {
            this.testingConfigError = testing.error;
            logger.error(`Ошибка загрузки тестинговой конфигурации: ${testing.error}`);
        }
    }
    requireTestingConfig() {
        if (this.testingConfigError) {
            throw new Error(this.testingConfigError);
        }
        if (!this.testingConfig) {
            throw new Error("Файл .db-testing.yaml не настроен");
        }
        return this.testingConfig;
    }
    resolveTestingHost(testing) {
        const config = this.requireTestingConfig();
        const env = normalizeTestingEnv(testing);
        const template = config.staging_host_template && isStagingEnv(env) ? config.staging_host_template : config.host_template;
        return template.split(TESTING_ENV_PLACEHOLDER).join(env);
    }
    resolveTestingConnection(testing, service) {
        const config = this.requireTestingConfig();
        const env = normalizeTestingEnv(testing);
        const serviceInfo = Object.prototype.hasOwnProperty.call(config.services, service)
            ? config.services[service]
            : undefined;
        if (!serviceInfo) {
            throw new Error(`Сервис ${service} не найден в .db-testing.yaml (services). Добавьте его в конфиг или проверьте имя.`);
        }
        const engineName = String(serviceInfo.engine);
        const engine = config.engines[engineName];
        const database = serviceInfo.database ? String(serviceInfo.database) : `${service}_auto_${testingEnvSuffix(env)}`;
        return {
            host: this.resolveTestingHost(env),
            port: engine.port,
            database,
            user: config.user,
            password: config.password,
            block_store: serviceInfo.block_store ? String(serviceInfo.block_store) : null,
            db_type: engine.type,
            engine: engineName,
            testing: env,
            service,
        };
    }
    /** [logical key, connection] for prod or a testing stand; testing falls back to TESTING_NAME. */
    resolveTarget(service, testing) {
        return this.resolveCoercedTarget(service, coerceTesting(testing));
    }
    /**
     * Same as resolveTarget for a stand that coerceTesting already resolved: null means prod.
     * Coercing twice would turn an explicit `prod` (null) back into TESTING_NAME.
     */
    resolveCoercedTarget(service, env) {
        if (env) {
            return [`${service}@${env}`, this.resolveTestingConnection(env, service)];
        }
        if (testingOnly()) {
            throw new Error(TESTING_ONLY_PROD_ERROR);
        }
        if (!Object.prototype.hasOwnProperty.call(this.connections, service)) {
            throw new Error(`БД ${service} не найдена в конфигурации`);
        }
        return [service, this.connections[service]];
    }
    blockStoreInfo(conn) {
        if (!conn.block_store) {
            return {};
        }
        return { block_store_database: conn.block_store, block_store_description: BLOCK_STORE_DESCRIPTION };
    }
    queryResponseContext(conn) {
        const context = { db_type: conn.db_type, sql_dialect_hint: sqlDialectHint(conn.db_type) };
        if (conn.engine) {
            context.engine = conn.engine;
        }
        return context;
    }
    connectionConfigSummary(conn) {
        const summary = {
            host: conn.host,
            database: conn.database,
            user: conn.user,
            db_type: conn.db_type,
            sql_dialect_hint: sqlDialectHint(conn.db_type),
            testing: conn.testing ?? null,
            service: conn.service ?? null,
        };
        if (conn.engine) {
            summary.engine = conn.engine;
        }
        return summary;
    }
    /** Every prod session is read-only at the database level; testing sessions may write. */
    session(conn, queryTimeoutSec, work) {
        return this.runSession(conn, { readOnly: isProdConnection(conn), connectTimeoutSec: connectTimeoutSec(), queryTimeoutSec }, work);
    }
    async readSummary(session, dbType) {
        const queries = connectionSummaryQueries(dbType);
        const info = { ...((await session.query(queries.info)).rows[0] ?? {}) };
        if (queries.size) {
            Object.assign(info, (await session.query(queries.size)).rows[0] ?? {});
        }
        const tablesCount = { ...((await session.query(queries.tablesCount)).rows[0] ?? {}) };
        return { info, tablesCount };
    }
    async fetchOneForList(key, conn) {
        try {
            const { info, tablesCount } = await this.session(conn, 0, (s) => this.readSummary(s, conn.db_type));
            return [
                key,
                {
                    ...info,
                    ...tablesCount,
                    connection_config: this.connectionConfigSummary(conn),
                    available: true,
                    ...this.blockStoreInfo(conn),
                },
            ];
        }
        catch (error) {
            return [
                key,
                {
                    available: false,
                    error: errorMessage(error),
                    connection_config: this.connectionConfigSummary(conn),
                    ...this.blockStoreInfo(conn),
                },
            ];
        }
    }
    listTargets(testing) {
        if (testing) {
            const env = normalizeTestingEnv(testing);
            const config = this.requireTestingConfig();
            return Object.keys(config.services).map((service) => [
                `${service}@${env}`,
                this.resolveTestingConnection(env, service),
            ]);
        }
        return Object.entries(this.connections);
    }
    /** Live connect to every catalog entry (no cache). */
    async listDatabasesFresh(testing = null) {
        const targets = this.listTargets(testing);
        if (targets.length === 0) {
            return {};
        }
        const entries = await mapWithConcurrency(targets, listMaxWorkers(targets.length), ([key, conn]) => this.fetchOneForList(key, conn));
        return Object.fromEntries(entries);
    }
    /** Catalog without TCP; a live check is get_database_info / execute_query. */
    listDatabasesCatalog(testing = null) {
        const result = {};
        for (const [key, conn] of this.listTargets(testing)) {
            result[key] = {
                available: null,
                probed: false,
                connection_config: this.connectionConfigSummary(conn),
                ...this.blockStoreInfo(conn),
            };
        }
        return result;
    }
    async listDatabases(testing) {
        const env = coerceTesting(testing);
        if (testingOnly() && !env) {
            throw new Error(TESTING_ONLY_LIST_ERROR);
        }
        const probe = listProbeEnabled();
        const cacheKey = `${env ? `testing:${env}` : "prod"}:${probe ? "probe" : "catalog"}`;
        const cached = this.listDatabasesCache.get(cacheKey);
        if (cached) {
            if (this.now() - cached.cachedAt < this.listDatabasesTtlMs) {
                logger.info(`list_databases cache hit key=${cacheKey}`);
                return structuredClone(cached.payload);
            }
            this.listDatabasesCache.delete(cacheKey);
        }
        logger.info(`list_databases cache miss key=${cacheKey}`);
        const result = probe ? await this.listDatabasesFresh(env) : this.listDatabasesCatalog(env);
        this.listDatabasesCache.set(cacheKey, { cachedAt: this.now(), payload: structuredClone(result) });
        return structuredClone(result);
    }
    async executeQuery(query, service, testing, timeout) {
        const env = coerceTesting(testing);
        const writeAllowed = env !== null;
        if (!validateQuery(query, writeAllowed)) {
            throw new Error("Запрос содержит недопустимые операции");
        }
        const startedAt = performance.now();
        const elapsedSec = () => (performance.now() - startedAt) / 1000;
        let timeoutSec;
        try {
            timeoutSec = normalizeQueryTimeoutSec(timeout);
        }
        catch (error) {
            return { success: false, error: errorMessage(error), service, testing: env, execution_time: 0 };
        }
        let key;
        let conn;
        try {
            [key, conn] = this.resolveCoercedTarget(service, env);
        }
        catch (error) {
            return {
                success: false,
                error: errorMessage(error),
                service,
                testing: env,
                execution_time: 0,
                timeout_sec: timeoutSec,
            };
        }
        const context = this.queryResponseContext(conn);
        const caution = stagingWriteCaution(env, query);
        try {
            const rows = await this.session(conn, timeoutSec, async (s) => {
                const result = await s.query(query);
                return result.hasResultSet ? result.rows : [];
            });
            const executionTime = elapsedSec();
            logger.info(`Запрос к БД ${key} выполнен за ${executionTime.toFixed(3)}с`);
            return {
                success: true,
                data: rows,
                rows_count: rows.length,
                execution_time: executionTime,
                timeout_sec: timeoutSec,
                service,
                testing: env,
                database: conn.database,
                ...context,
                ...(caution ? { caution } : {}),
            };
        }
        catch (error) {
            const original = errorMessage(error);
            logger.error(`Ошибка выполнения запроса к БД ${key}: ${original}`);
            const message = timeoutSec > 0 && isQueryTimeoutError(original)
                ? `Запрос превысил лимит ${timeoutSec}с и был прерван. ` +
                    `Сократи SQL (индексы, WHERE, LIMIT) или передай timeout больше ${timeoutSec}. ` +
                    `Исходная ошибка: ${original}`
                : original;
            return {
                success: false,
                error: message,
                service,
                testing: env,
                execution_time: elapsedSec(),
                timeout_sec: timeoutSec,
                ...context,
                ...(caution ? { caution } : {}),
            };
        }
    }
    async getDatabaseInfo(service, testing) {
        const env = coerceTesting(testing);
        let key;
        let conn;
        try {
            [key, conn] = this.resolveCoercedTarget(service, env);
        }
        catch (error) {
            return { success: false, error: errorMessage(error), service, testing: env };
        }
        try {
            const { info, tables } = await this.session(conn, 0, async (s) => {
                const summary = await this.readSummary(s, conn.db_type);
                const tableRows = (await s.query(tablesBySizeQuery(conn.db_type))).rows.map((row) => ({ ...row }));
                return { info: summary.info, tables: tableRows };
            });
            return {
                success: true,
                service,
                testing: env,
                database: conn.database,
                info,
                tables,
                tables_count: tables.length,
                connection_config: this.connectionConfigSummary(conn),
                ...this.blockStoreInfo(conn),
            };
        }
        catch (error) {
            logger.error(`Ошибка получения информации о БД ${key}: ${errorMessage(error)}`);
            return {
                success: false,
                error: errorMessage(error),
                service,
                testing: env,
                connection_config: this.connectionConfigSummary(conn),
                ...this.blockStoreInfo(conn),
            };
        }
    }
    async getTablesSchemas(service, testing, tableNames) {
        const env = coerceTesting(testing);
        const requested = tableNames ?? null;
        let key;
        let conn;
        try {
            [key, conn] = this.resolveCoercedTarget(service, env);
        }
        catch (error) {
            return { success: false, error: errorMessage(error), service, testing: env };
        }
        const names = tableNames && tableNames.length > 0 ? tableNames : [];
        try {
            const tables = await this.session(conn, 0, async (s) => {
                const columns = await s.query(columnsQuery(conn.db_type, names.length), names);
                const indexes = await s.query(indexesQuery(conn.db_type, names.length), names);
                const byTable = {};
                const tableEntry = (name) => (byTable[name] ?? (byTable[name] = { columns: [], indexes: [] }));
                for (const row of columns.rows) {
                    tableEntry(String(row.table_name)).columns.push({
                        column_name: row.column_name,
                        data_type: row.data_type,
                        is_nullable: row.is_nullable,
                        column_default: row.column_default,
                        character_maximum_length: row.character_maximum_length ?? null,
                        numeric_precision: row.numeric_precision ?? null,
                        numeric_scale: row.numeric_scale ?? null,
                    });
                }
                for (const row of indexes.rows) {
                    tableEntry(String(row.tablename)).indexes.push({
                        indexname: row.indexname,
                        indexdef: row.indexdef,
                    });
                }
                return byTable;
            });
            return {
                success: true,
                service,
                testing: env,
                database: conn.database,
                tables,
                tables_count: Object.keys(tables).length,
                requested_tables: requested,
            };
        }
        catch (error) {
            logger.error(`Ошибка получения схем таблиц для БД ${key}: ${errorMessage(error)}`);
            return {
                success: false,
                error: errorMessage(error),
                service,
                testing: env,
                requested_tables: requested,
            };
        }
    }
}
