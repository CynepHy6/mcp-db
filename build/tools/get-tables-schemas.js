import { z } from "zod";
import { textContent } from "../utils/json.js";
import { runTool, serviceField, testingField } from "./common.js";
export const getTablesSchemasDescription = () => "Получить схемы указанных таблиц или всех таблиц в БД";
export const getTablesSchemasSchema = () => ({
    service: serviceField(),
    testing: testingField(),
    table_names: z
        .array(z.string())
        .optional()
        .describe("Список названий таблиц (необязательно, если не указан - возвращает все таблицы)"),
});
export const getTablesSchemasHandler = (manager) => async ({ service, testing, table_names }) => {
    if (!service) {
        return textContent("Ошибка: необходимо указать service");
    }
    return runTool("get_tables_schemas", () => manager.getTablesSchemas(service, testing, table_names));
};
