import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP-аннотации инструментов. Клиент (Cursor, Claude, Рабочий стол) по `readOnlyHint` решает,
 * спрашивать ли человека и пускать ли вызов в режимах только чтения. Без аннотации клиент угадывает
 * по имени. Аннотация статична на весь сервер, поэтому пометка — по худшему случаю среди конфигов.
 */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
/**
 * Read-only гарантирован только на prod (`BEGIN READ ONLY` / `START TRANSACTION READ ONLY`).
 * На тестинге и стейджинге запрос идёт без фильтра и коммитится: INSERT, UPDATE, DELETE, DDL.
 */
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
    execute_query: DESTRUCTIVE,
    get_tables_schemas: READ_ONLY,
    list_databases: READ_ONLY,
    get_database_info: READ_ONLY,
};

/** Аннотации инструмента по имени. Незнакомое имя — ошибка: новый инструмент без пометки не регистрируется. */
export function toolAnnotations(name: string): ToolAnnotations {
    const annotations = TOOL_ANNOTATIONS[name];
    if (!annotations) throw new Error(`No MCP annotations for tool "${name}"`);
    return annotations;
}
