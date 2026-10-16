import mysql from "mysql2/promise";
export const withMysqlSession = async (conn, options, work) => {
    const connection = await mysql.createConnection({
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
        database: conn.database,
        ...(options.connectTimeoutSec > 0 ? { connectTimeout: options.connectTimeoutSec * 1000 } : {}),
        // One statement per query: `COMMIT; …` cannot leave the read-only transaction.
        multipleStatements: false,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: false,
    });
    const timeoutMs = options.queryTimeoutSec > 0 ? Math.trunc(options.queryTimeoutSec) * 1000 : 0;
    try {
        if (timeoutMs > 0) {
            // SELECT only; the client-side timeout below covers the rest.
            await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${timeoutMs}`);
        }
        if (options.readOnly) {
            await connection.query("START TRANSACTION READ ONLY");
        }
        const session = {
            async query(sql, params) {
                const [rows] = await connection.query({ sql, ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}) }, params ?? []);
                const hasResultSet = Array.isArray(rows);
                return { rows: hasResultSet ? rows : [], hasResultSet };
            },
        };
        const value = await work(session);
        await connection.query(options.readOnly ? "ROLLBACK" : "COMMIT");
        return value;
    }
    finally {
        await connection.end().catch(() => connection.destroy());
    }
};
