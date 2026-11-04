import pg from "pg";
const INT8_OID = 20;
/**
 * date, time, timestamp, timestamptz, interval, timetz: the server text. No JS Date round-trip through
 * the local zone, and no `{ milliseconds: … }` object for an interval.
 */
const RAW_TEXT_OIDS = new Set([1082, 1083, 1114, 1184, 1186, 1266]);
/** Arrays of the same types: a list of server strings, parsed like text[]. */
const RAW_TEXT_ARRAY_OIDS = new Set([1182, 1183, 1115, 1185, 1187, 1270]);
const TEXT_ARRAY_OID = 1009;
export const pgTypeParser = (oid, format) => {
    if (oid === INT8_OID) {
        return (value) => {
            const parsed = Number(value);
            return Number.isSafeInteger(parsed) ? parsed : value;
        };
    }
    if (RAW_TEXT_OIDS.has(oid)) {
        return (value) => value;
    }
    if (RAW_TEXT_ARRAY_OIDS.has(oid)) {
        return pg.types.getTypeParser(TEXT_ARRAY_OID, format);
    }
    return pg.types.getTypeParser(oid, format);
};
/** SQLSTATE from the server (auth, pg_hba): libpq sslmode=prefer retries those without SSL. */
const isServerRejection = (error) => /does not support SSL/i.test(String(error?.message)) ||
    (typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code));
/** libpq default sslmode=prefer: try TLS without certificate checks, fall back to plain TCP. */
export const connectPostgres = async (conn, connectTimeoutSec) => {
    const base = {
        host: conn.host,
        port: conn.port,
        database: conn.database,
        user: conn.user,
        password: conn.password,
        connectionTimeoutMillis: connectTimeoutSec > 0 ? connectTimeoutSec * 1000 : 0,
        types: { getTypeParser: pgTypeParser },
    };
    const tlsClient = new pg.Client({ ...base, ssl: { rejectUnauthorized: false } });
    try {
        await tlsClient.connect();
        return tlsClient;
    }
    catch (error) {
        await tlsClient.end().catch(() => undefined);
        if (!isServerRejection(error)) {
            throw error;
        }
    }
    const plainClient = new pg.Client(base);
    try {
        await plainClient.connect();
        return plainClient;
    }
    catch (error) {
        await plainClient.end().catch(() => undefined);
        throw error;
    }
};
const toResult = (result) => ({
    rows: (result.rows ?? []),
    hasResultSet: (result.fields?.length ?? 0) > 0 || result.command === "SELECT",
});
export const withPostgresSession = async (conn, options, work) => {
    const client = await connectPostgres(conn, options.connectTimeoutSec);
    try {
        if (options.readOnly) {
            await client.query("BEGIN READ ONLY");
        }
        if (options.queryTimeoutSec > 0) {
            const timeoutMs = Math.trunc(options.queryTimeoutSec) * 1000;
            await client.query(`SET ${options.readOnly ? "LOCAL " : ""}statement_timeout = ${timeoutMs}`);
        }
        const session = {
            async query(sql, params) {
                if (options.readOnly || (params && params.length > 0)) {
                    // Extended protocol: one statement per call, so `COMMIT; …` cannot leave the read-only transaction.
                    const config = {
                        text: sql,
                        values: params ?? [],
                        ...(options.readOnly ? { queryMode: "extended" } : {}),
                    };
                    return toResult(await client.query(config));
                }
                // Simple protocol keeps multi-statement scripts on testing; the last result wins, as with psycopg2.
                const result = (await client.query(sql));
                return toResult(Array.isArray(result) ? result[result.length - 1] : result);
            },
        };
        const value = await work(session);
        if (options.readOnly) {
            await client.query("ROLLBACK");
        }
        return value;
    }
    finally {
        await client.end().catch(() => undefined);
    }
};
