import { z } from "zod";
import { testingOnly } from "../utils/env.js";
import { textContent } from "../utils/json.js";
import { runTool, serviceField, testingField } from "./common.js";
export const executeQueryDescription = () => testingOnly()
    ? "SQL к БД тестинга. testing по умолчанию TESTING_NAME; любой стенд можно указать явно. " +
        "Write разрешён. Prod-каталога нет. " +
        "По умолчанию лимит 30с (timeout; 0 = без лимита). " +
        "Ответ содержит db_type и sql_dialect_hint. " +
        "При timeout — сузь SQL, не поднимай лимит зря"
    : "Выполнить SQL к service [, testing]. Prod — read-only; testing — любые SQL. " +
        "По умолчанию лимит выполнения 30с (параметр timeout; 0 = без лимита). " +
        "Ответ содержит db_type и sql_dialect_hint — используй их для синтаксиса. " +
        "При syntax error пересобери запрос под db_type; для mysql не используй " +
        "postgres-алиасы без обратных кавычек. При timeout — сузь SQL, не поднимай лимит зря";
export const executeQuerySchema = () => ({
    query: z
        .string()
        .describe("SQL в диалекте db_type целевой БД. " +
        "Неизвестен db_type — сначала get_database_info(service[, testing])"),
    service: serviceField(),
    testing: testingField(),
    timeout: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Лимит выполнения SQL в секундах. По умолчанию 30. " +
        "0 — без лимита. При превышении запрос прерывается; " +
        "сначала оптимизируй SQL (WHERE, LIMIT), потом увеличивай timeout"),
});
export const executeQueryHandler = (manager) => async ({ query, service, testing, timeout }) => {
    if (!query || !service) {
        return textContent("Ошибка: необходимо указать query и service");
    }
    return runTool("execute_query", () => manager.executeQuery(query, service, testing, timeout));
};
