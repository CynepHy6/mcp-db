export const sqlDialectHint = (dbType) => {
    if (dbType === "mysql") {
        return ("MySQL: DATABASE(), USER() или CURRENT_USER() AS `current_user`, VERSION(); " +
            "зарезервированные слова в алиасах — обратные кавычки");
    }
    return ("PostgreSQL: current_database(), current_user, version(); " +
        "регистрозависимые идентификаторы — в двойных кавычках");
};
/** list_databases / get_database_info: info, size, tables_count. */
export const connectionSummaryQueries = (dbType) => {
    if (dbType === "mysql") {
        return {
            info: `
                SELECT
                    DATABASE() AS database_name,
                    CURRENT_USER() AS \`current_user\`,
                    VERSION() AS \`version\`
                `,
            size: `
                SELECT COALESCE(SUM(data_length + index_length), 0) as size_bytes
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                `,
            tablesCount: `
                SELECT COUNT(*) as tables_count
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                  AND table_type = 'BASE TABLE'
                `,
        };
    }
    return {
        info: `
            SELECT
                current_database() as database_name,
                current_user as current_user,
                version() as version,
                pg_database_size(current_database()) as size_bytes
            `,
        size: "",
        tablesCount: `
            SELECT COUNT(*) as tables_count
            FROM information_schema.tables
            WHERE table_schema = 'public'
            `,
    };
};
export const tablesBySizeQuery = (dbType) => {
    if (dbType === "mysql") {
        return `
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
            `;
    }
    return `
            SELECT
                tablename,
                pg_size_pretty(pg_total_relation_size('public.'||tablename)) as size
            FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY pg_total_relation_size('public.'||tablename) DESC
            `;
};
/** `$1, $2` for Postgres, `?, ?` for MySQL. */
export const placeholders = (dbType, count) => Array.from({ length: count }, (_, i) => (dbType === "mysql" ? "?" : `$${i + 1}`)).join(",");
/** Explicit aliases: MySQL 8 returns information_schema column labels in upper case. */
export const columnsQuery = (dbType, tableCount) => {
    const schemaFilter = dbType === "mysql" ? "table_schema = DATABASE()" : "table_schema = 'public'";
    const tableFilter = tableCount > 0 ? ` AND table_name IN (${placeholders(dbType, tableCount)})` : "";
    return `
        SELECT
            table_name AS table_name,
            column_name AS column_name,
            data_type AS data_type,
            is_nullable AS is_nullable,
            column_default AS column_default,
            character_maximum_length AS character_maximum_length,
            numeric_precision AS numeric_precision,
            numeric_scale AS numeric_scale
        FROM information_schema.columns
        WHERE ${schemaFilter}${tableFilter}
        ORDER BY table_name, ordinal_position
        `;
};
export const indexesQuery = (dbType, tableCount) => {
    if (dbType === "mysql") {
        const filter = tableCount > 0 ? ` AND table_name IN (${placeholders(dbType, tableCount)})` : "";
        return `
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
            WHERE table_schema = DATABASE()${filter}
            GROUP BY table_name, index_name
            ORDER BY table_name, index_name
            `;
    }
    const filter = tableCount > 0 ? ` AND tablename IN (${placeholders(dbType, tableCount)})` : "";
    return `
            SELECT
                tablename,
                indexname,
                indexdef
            FROM pg_indexes
            WHERE schemaname = 'public'${filter}
            `;
};
