import { readFileSync } from "fs";
import { parse } from "yaml";
import { parseInteger } from "./env.js";
import { logger } from "./logger.js";
import { TESTING_ENV_PLACEHOLDER } from "./testing-env.js";
const isDict = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** Python repr() for the values that end up in error texts. */
const repr = (value) => {
    if (typeof value === "string") {
        return `'${value}'`;
    }
    if (value === null || value === undefined) {
        return "None";
    }
    return String(value);
};
const LEGACY_RESERVED_KEYS = new Set(["block_store", "host", "port", "user", "password", "type", "database"]);
/** PyYAML parity: YAML 1.1 scalars (yes/no, 0123 …) resolve the same way as in the Python server. */
export const parseYaml = (text) => parse(text, { version: "1.1" });
/** Host prefix of a replica first, then the standard ports 3306/5432. */
export const inferDbType = (host, port) => {
    const hostLower = host.toLowerCase();
    if (hostLower.startsWith("mysql-")) {
        return "mysql";
    }
    if (hostLower.startsWith("pgsql-")) {
        return "postgres";
    }
    if (port === 3306) {
        return "mysql";
    }
    return "postgres";
};
/** Legacy entry: `<host>: <port>` and `<user>: <password>` next to the reserved keys. */
export const parseLegacyEntry = (dbInfo) => {
    let host = null;
    let port = null;
    let user = null;
    let password = null;
    for (const [key, value] of Object.entries(dbInfo)) {
        if (LEGACY_RESERVED_KEYS.has(key)) {
            continue;
        }
        if (typeof value === "number" && Number.isInteger(value)) {
            host = key;
            port = value;
        }
        else if (typeof value === "string") {
            user = key;
            password = value;
        }
    }
    return {
        host,
        port,
        user,
        password,
        block_store: dbInfo.block_store ?? null,
        type: dbInfo.type ?? null,
        database: dbInfo.database ?? null,
    };
};
const pick = (primary, fallback, key) => primary[key] || fallback[key] || null;
export const normalizeProdEntry = (dbName, dbInfo) => {
    if (!isDict(dbInfo)) {
        throw new Error(`Некорректная конфигурация БД ${dbName}: ожидается объект`);
    }
    const legacy = parseLegacyEntry(dbInfo);
    const host = pick(dbInfo, legacy, "host");
    const port = pick(dbInfo, legacy, "port");
    const user = pick(dbInfo, legacy, "user");
    const password = pick(dbInfo, legacy, "password");
    if (!host || !port || !user || !password) {
        return null;
    }
    const portNumber = parseInteger(port);
    if (portNumber === null) {
        throw new Error(`Некорректный port для БД ${dbName}: ${repr(port)}`);
    }
    const hostText = String(host);
    const type = pick(dbInfo, legacy, "type");
    const database = pick(dbInfo, legacy, "database");
    const blockStore = pick(dbInfo, legacy, "block_store");
    return {
        host: hostText,
        port: portNumber,
        database: database ? String(database) : dbName,
        user: String(user),
        password: String(password),
        block_store: blockStore ? String(blockStore) : null,
        db_type: type ? String(type) : inferDbType(hostText, portNumber),
    };
};
/** Prod catalog (.db.yaml). A missing or broken file is fatal, as in the Python server. */
export const loadProdConfig = (configPath) => {
    let text;
    try {
        text = readFileSync(configPath, "utf8");
    }
    catch (error) {
        if (error?.code === "ENOENT") {
            throw new Error(`Файл конфигурации ${configPath} не найден`);
        }
        throw error;
    }
    const dbConfig = parseYaml(text);
    if (!isDict(dbConfig)) {
        throw new Error("Конфигурация .db.yaml должна быть объектом");
    }
    if ("_testing" in dbConfig) {
        throw new Error("Секция _testing в .db.yaml больше не поддерживается. Используйте отдельный файл .db-testing.yaml");
    }
    const connections = {};
    for (const [dbName, dbInfo] of Object.entries(dbConfig)) {
        const normalized = normalizeProdEntry(dbName, dbInfo);
        if (normalized) {
            connections[dbName] = normalized;
        }
        else {
            logger.warn(`Неполная конфигурация для БД ${dbName}`);
        }
    }
    return connections;
};
const testingPortMissingError = (engineName) => `Прочитать данные с тестинга невозможно — не указан port в .db-testing.yaml для engine «${engineName}»`;
const testingTypeMissingError = (engineName) => `Прочитать данные с тестинга невозможно — не указан type в .db-testing.yaml для engine «${engineName}»`;
const resolveEngine = (engineName, engineInfo) => {
    if (!isDict(engineInfo)) {
        throw new Error(`Некорректный engine ${engineName} в .db-testing.yaml`);
    }
    if (engineInfo.port === undefined || engineInfo.port === null) {
        throw new Error(testingPortMissingError(engineName));
    }
    const dbType = engineInfo.type;
    if (!dbType) {
        throw new Error(testingTypeMissingError(engineName));
    }
    const port = parseInteger(engineInfo.port);
    if (port === null) {
        throw new Error("Прочитать данные с тестинга невозможно — " +
            `некорректный port для engine «${engineName}» в .db-testing.yaml: ${repr(engineInfo.port)}`);
    }
    if (dbType !== "mysql" && dbType !== "postgres") {
        throw new Error("Прочитать данные с тестинга невозможно — " +
            `некорректный type для engine «${engineName}» в .db-testing.yaml: ${repr(dbType)} (ожидается mysql или postgres)`);
    }
    return { port, type: dbType };
};
export const normalizeTestingConfig = (testingInfo) => {
    if (!isDict(testingInfo)) {
        throw new Error("Конфигурация .db-testing.yaml должна быть объектом");
    }
    for (const field of ["user", "password", "host_template", "engines", "services"]) {
        if (!(field in testingInfo)) {
            throw new Error(`В .db-testing.yaml отсутствует обязательное поле ${field}`);
        }
    }
    const hostTemplate = String(testingInfo.host_template ?? "");
    if (!hostTemplate.includes(TESTING_ENV_PLACEHOLDER)) {
        throw new Error(`host_template должен содержать плейсхолдер ${TESTING_ENV_PLACEHOLDER}`);
    }
    const stagingHostTemplate = testingInfo.staging_host_template ? String(testingInfo.staging_host_template) : null;
    if (stagingHostTemplate && !stagingHostTemplate.includes(TESTING_ENV_PLACEHOLDER)) {
        throw new Error(`staging_host_template должен содержать плейсхолдер ${TESTING_ENV_PLACEHOLDER}`);
    }
    const engines = testingInfo.engines;
    const services = testingInfo.services;
    if (!isDict(engines) || Object.keys(engines).length === 0) {
        throw new Error(".db-testing.yaml: engines должен быть непустым объектом");
    }
    if (!isDict(services) || Object.keys(services).length === 0) {
        throw new Error(".db-testing.yaml: services должен быть непустым объектом");
    }
    const normalizedEngines = {};
    for (const [engineName, engineInfo] of Object.entries(engines)) {
        normalizedEngines[engineName] = resolveEngine(engineName, engineInfo);
    }
    const normalizedServices = {};
    for (const [serviceName, serviceInfo] of Object.entries(services)) {
        if (typeof serviceInfo === "string") {
            normalizedServices[serviceName] = { engine: serviceInfo };
            continue;
        }
        if (!isDict(serviceInfo) || !("engine" in serviceInfo)) {
            throw new Error(`Некорректный сервис ${serviceName} в .db-testing.yaml`);
        }
        normalizedServices[serviceName] = { ...serviceInfo };
    }
    for (const [serviceName, serviceInfo] of Object.entries(normalizedServices)) {
        if (!(String(serviceInfo.engine) in normalizedEngines)) {
            throw new Error(`Сервис ${serviceName} ссылается на неизвестный engine ${serviceInfo.engine}`);
        }
    }
    return {
        user: String(testingInfo.user),
        password: String(testingInfo.password),
        host_template: hostTemplate,
        staging_host_template: stagingHostTemplate,
        engines: normalizedEngines,
        services: normalizedServices,
    };
};
/** Testing catalog (.db-testing.yaml) is optional; a broken file is reported per call, not at startup. */
export const loadTestingConfig = (testingConfigPath) => {
    let text;
    try {
        text = readFileSync(testingConfigPath, "utf8");
    }
    catch (error) {
        if (error?.code === "ENOENT") {
            return { status: "missing" };
        }
        return { status: "error", error: String(error?.message ?? error) };
    }
    try {
        const parsed = parseYaml(text);
        if (!isDict(parsed)) {
            throw new Error("Конфигурация .db-testing.yaml должна быть объектом");
        }
        return { status: "loaded", config: normalizeTestingConfig(parsed) };
    }
    catch (error) {
        return { status: "error", error: String(error?.message ?? error) };
    }
};
