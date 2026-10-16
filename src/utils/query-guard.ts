import { isStagingEnv } from "./testing-env.js";

export const READ_KEYWORDS = ["SELECT", "WITH", "EXPLAIN", "SHOW", "DESCRIBE", "VALUES"] as const;

export const DANGEROUS_KEYWORDS = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "CREATE",
    "ALTER",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "EXEC",
    "EXECUTE",
] as const;

/** Whole word only: `updated_at` is not UPDATE, `(DELETE` is. */
const DANGEROUS_RE = new RegExp(`(?<![A-Z0-9_])(?:${DANGEROUS_KEYWORDS.join("|")})(?![A-Z0-9_])`);

/** Drops `--` line comments and block comments, trims, uppercases. */
export const normalizeQueryText = (query: string): string =>
    query
        .replace(/--.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim()
        .toUpperCase();

export const startsWithReadKeyword = (normalized: string): boolean =>
    READ_KEYWORDS.some((keyword) => normalized.startsWith(keyword));

export const containsDangerousKeyword = (normalized: string): boolean => DANGEROUS_RE.test(normalized);

/**
 * First filter for prod: the query has to start like a read and must not mention a write statement.
 * The guarantee itself is the read-only transaction the prod session runs in.
 */
export const validateQuery = (query: string, writeAllowed: boolean): boolean => {
    if (writeAllowed) {
        return true;
    }
    const normalized = normalizeQueryText(query);
    if (!startsWithReadKeyword(normalized)) {
        return false;
    }
    return !containsDangerousKeyword(normalized);
};

/** Heuristic for the staging advisory only. */
export const looksLikeWriteQuery = (query: string): boolean => !startsWithReadKeyword(normalizeQueryText(query));

export const STAGING_WRITE_CAUTION =
    "Стейджинг: прямое изменение данных технически не блокируется (не опасно для прод-пользователей), " +
    "но не рекомендуется без явной необходимости — предпочитай SELECT.";

export const stagingWriteCaution = (testing: string | null, query: string): string | null => {
    if (!testing || !isStagingEnv(testing) || !looksLikeWriteQuery(query)) {
        return null;
    }
    return STAGING_WRITE_CAUTION;
};

const TIMEOUT_MARKERS = [
    "statement timeout",
    "canceling statement due to statement timeout",
    "max_execution_time",
    "maximum statement execution time exceeded",
    "timed out",
    "timeout",
    "lost connection",
];

export const isQueryTimeoutError = (message: string): boolean => {
    const lowered = message.toLowerCase();
    return TIMEOUT_MARKERS.some((marker) => lowered.includes(marker));
};
