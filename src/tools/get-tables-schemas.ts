import { z } from "zod";
import { DatabaseManager } from "../clients/database-manager.js";
import { textContent } from "../utils/json.js";
import { runTool, serviceField, testingField } from "./common.js";

export const getTablesSchemasDescription = (): string => "Получить схемы указанных таблиц или всех таблиц в БД";

export const getTablesSchemasSchema = () => ({
    service: serviceField(),
    testing: testingField(),
    table_names: z
        .array(z.string())
        .optional()
        .describe("Список названий таблиц (необязательно, если не указан - возвращает все таблицы)"),
});

interface GetTablesSchemasArgs {
    service?: string;
    testing?: string;
    table_names?: string[];
}

export const getTablesSchemasHandler =
    (manager: DatabaseManager) =>
    async ({ service, testing, table_names }: GetTablesSchemasArgs) => {
        if (!service) {
            return textContent("Ошибка: необходимо указать service");
        }
        return runTool("get_tables_schemas", () => manager.getTablesSchemas(service, testing, table_names));
    };
