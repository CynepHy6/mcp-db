import { textContent } from "../utils/json.js";
import { runTool, serviceField, testingField } from "./common.js";
export const getDatabaseInfoDescription = () => "Информация о БД: таблицы, размер, connection_config.db_type и sql_dialect_hint. " +
    "Вызывай перед первым execute_query к новому service";
export const getDatabaseInfoSchema = () => ({
    service: serviceField(),
    testing: testingField(),
});
export const getDatabaseInfoHandler = (manager) => async ({ service, testing }) => {
    if (!service) {
        return textContent("Ошибка: необходимо указать service");
    }
    return runTool("get_database_info", () => manager.getDatabaseInfo(service, testing));
};
