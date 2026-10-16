import { logger } from "./logger.js";
export const DEFAULT_QUERY_TIMEOUT_SEC = 30;
export const DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 2;
export const DEFAULT_CONNECT_TIMEOUT_SEC = 2;
export const DEFAULT_LIST_MAX_WORKERS = 16;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const rawEnv = (name) => (process.env[name] ?? "").trim().toLowerCase();
export const envFlag = (name) => TRUE_VALUES.has(rawEnv(name));
/** MCP_DB_TESTING_ONLY: no prod catalog, requests without a stand are rejected. */
export const testingOnly = () => envFlag("MCP_DB_TESTING_ONLY");
/** MCP_DB_LIST_PROBE: explicit value wins; otherwise probe unless testing-only. */
export const listProbeEnabled = () => {
    const raw = rawEnv("MCP_DB_LIST_PROBE");
    if (TRUE_VALUES.has(raw)) {
        return true;
    }
    if (FALSE_VALUES.has(raw)) {
        return false;
    }
    return !testingOnly();
};
export const defaultTestingFromEnv = () => {
    const raw = (process.env.TESTING_NAME ?? "").trim();
    return raw || null;
};
const INTEGER_RE = /^\s*[+-]?\d+\s*$/;
/** Python int() for the inputs that matter here: integers, floats (truncated), integer strings. */
export const parseInteger = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === "string" && INTEGER_RE.test(value)) {
        return parseInt(value, 10);
    }
    return null;
};
const intFromEnv = (name, fallback, min) => {
    const raw = process.env[name];
    if (raw === undefined) {
        return fallback;
    }
    const value = parseInteger(raw);
    if (value === null) {
        logger.warn(`Некорректный ${name}=${JSON.stringify(raw)}, использую ${fallback}`);
        return fallback;
    }
    return Math.max(min, value);
};
export const defaultQueryTimeoutSec = () => intFromEnv("MCP_DB_QUERY_TIMEOUT", DEFAULT_QUERY_TIMEOUT_SEC, 0);
export const maxConcurrentToolCalls = () => intFromEnv("MCP_DB_MAX_CONCURRENT_TOOL_CALLS", DEFAULT_MAX_CONCURRENT_TOOL_CALLS, 1);
export const connectTimeoutSec = () => intFromEnv("MCP_DB_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT_SEC, 0);
export const listMaxWorkers = (targets) => {
    if (process.env.MCP_DB_LIST_MAX_WORKERS) {
        return intFromEnv("MCP_DB_LIST_MAX_WORKERS", DEFAULT_LIST_MAX_WORKERS, 1);
    }
    return Math.max(1, Math.min(DEFAULT_LIST_MAX_WORKERS, targets));
};
/** SQL limit in seconds: undefined/null → default, 0 → no limit. */
export const normalizeQueryTimeoutSec = (timeout) => {
    if (timeout === undefined || timeout === null) {
        return defaultQueryTimeoutSec();
    }
    const value = parseInteger(timeout);
    if (value === null) {
        throw new Error(`Параметр timeout должен быть целым числом секунд (0 = без лимита), получено: ${JSON.stringify(timeout)}`);
    }
    if (value < 0) {
        throw new Error("Параметр timeout не может быть отрицательным");
    }
    return value;
};
