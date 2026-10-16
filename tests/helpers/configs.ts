import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { DatabaseManager, DatabaseManagerOptions } from "../../src/clients/database-manager";

// Fictitious hosts only: not prod or testing infrastructure.
export const MYSQL_REPL_HOST = "mysql-example-repl.example.test";
export const PGSQL_REPL_HOST = "pgsql-example-repl.example.test";
export const TEST_ENV_HOST = "test-env-local.example.test";
export const LEGACY_HOST = "legacy-host.example.test";
export const TESTING_ALPHA = "test-alpha";
export const TESTING_BETA = "test-beta";

export const TESTING_CONFIG = `
user: test_user
password: secret
host_template: "{{env}}-local.example.test"
engines:
  mysql8: { port: 13306, type: mysql }
  pg11:   { port: 15432, type: postgres }
  pg15:   { port: 25432, type: postgres }
  pg9:    { port: 35432, type: postgres }
services:
  crm: pg15
  trm: pg11
  timetable:
    engine: mysql8
    database: timetable
  skysmart_english:
    engine: pg11
    block_store: vimbox_store_english_skysmart
`;

export const TESTING_CONFIG_WITH_STAGING = `
user: test_user
password: secret
host_template: "{{env}}-local.example.test"
staging_host_template: "yc-staging-{{env}}-db.example.test"
engines:
  mysql8: { port: 13306, type: mysql }
  pg11:   { port: 15432, type: postgres }
  pg15:   { port: 25432, type: postgres }
  pg9:    { port: 35432, type: postgres }
services:
  crm: pg15
  trm: pg11
`;

export const PROD_CONFIG = `prod_db:\n  ${LEGACY_HOST}: 5432\n  legacy_user: secret\n`;

export interface ConfigPaths {
    configPath: string;
    testingConfigPath: string;
}

export const writeConfigs = (prodText: string | null, testingText: string | null): ConfigPaths => {
    const dir = mkdtempSync(path.join(tmpdir(), "mcp-db-test-"));
    const configPath = path.join(dir, "db.yaml");
    const testingConfigPath = path.join(dir, "db-testing.yaml");
    if (prodText !== null) {
        writeFileSync(configPath, prodText.trim() + "\n", "utf8");
    }
    if (testingText !== null) {
        writeFileSync(testingConfigPath, testingText.trim() + "\n", "utf8");
    }
    return { configPath, testingConfigPath };
};

export const createManager = (
    prodText: string | null = PROD_CONFIG,
    testingText: string | null = TESTING_CONFIG,
    options: Partial<DatabaseManagerOptions> = {},
): DatabaseManager => new DatabaseManager({ ...writeConfigs(prodText, testingText), ...options });
