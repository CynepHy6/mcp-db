import { z } from "zod";
import { maxConcurrentToolCalls, testingOnly } from "../utils/env.js";
import { textContent, toJson } from "../utils/json.js";
import { logger } from "../utils/logger.js";
import { Semaphore } from "../utils/semaphore.js";

export const serviceDescription = (): string =>
    testingOnly()
        ? "Имя сервиса из testing-каталога (video, trm, math, …). Prod этим сервером не открывается"
        : "Имя сервиса/БД: для prod — ключ в .db.yaml (crm, learning_groups_storage); " +
          "для тестинга — имя из .db-testing.yaml services (crm, trm, timetable)";

export const testingDescription = (): string =>
    testingOnly()
        ? "Стенд test-yNN / sN / qa-panel yNN. Если не передан — TESTING_NAME. " +
          "Явный testing побеждает (в том числе чужой стенд во внутреннем контуре)"
        : "Имя тестинга/стейджинга (test-y10, test-alpha, my-env, s2). " +
          "qa-panel shortName yNN (y10) — алиас для test-yNN. " +
          "При указании подключение строится из .db-testing.yaml. " +
          "Стейджинги (s2, s6, ...) резолвятся через staging_host_template, если он задан; " +
          "запись на стейджинг технически разрешена, но не рекомендуется без явной необходимости";

export const serviceField = () => z.string().describe(serviceDescription());
export const testingField = () => z.string().optional().describe(testingDescription());

let semaphore: Semaphore | null = null;

/** MCP_DB_MAX_CONCURRENT_TOOL_CALLS is read per call; a changed limit gets a fresh semaphore. */
const toolCallSemaphore = (): Semaphore => {
    const limit = maxConcurrentToolCalls();
    if (!semaphore || semaphore.limit !== limit) {
        semaphore = new Semaphore(limit);
    }
    return semaphore;
};

export type ToolResult = ReturnType<typeof textContent>;

/** Concurrency limit for DB work; a thrown error becomes `Ошибка: …` text, as the client expects. */
export const runTool = async (name: string, body: () => Promise<unknown>): Promise<ToolResult> => {
    try {
        const result = await toolCallSemaphore().run(body);
        return textContent(toJson(result));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка выполнения инструмента ${name}: ${message}`);
        return textContent(`Ошибка: ${message}`);
    }
};
