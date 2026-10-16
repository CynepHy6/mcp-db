import { defaultTestingFromEnv } from "./env.js";
export const TESTING_ENV_PLACEHOLDER = "{{env}}";
/** Staging stands are s2, s6, … (no test- prefix); testing stands are test-yNN or free-form names. */
export const STAGING_ENV_PATTERN = /^s\d+$/;
/** qa-panel shortName of a personal stand (y10, y148): alias for test-yNN. */
export const PERSONAL_TESTING_SHORT_PATTERN = /^y\d+$/;
export const normalizeTestingEnv = (testing) => PERSONAL_TESTING_SHORT_PATTERN.test(testing) ? `test-${testing}` : testing;
/** test-alpha → alpha; without the test- prefix the suffix is the name itself. */
export const testingEnvSuffix = (testing) => testing.startsWith("test-") ? testing.slice("test-".length) : testing;
export const isStagingEnv = (testing) => STAGING_ENV_PATTERN.test(testing);
/** Explicit `testing: "prod"` selects the prod catalog even when TESTING_NAME is set. */
export const PROD_TESTING_VALUE = "prod";
export const isProdTesting = (testing) => typeof testing === "string" && testing.trim().toLowerCase() === PROD_TESTING_VALUE;
/**
 * Explicit testing wins; otherwise TESTING_NAME. An empty string counts as not set.
 * `prod` returns null: the caller asked for the prod catalog, not a stand.
 */
export const coerceTesting = (testing) => {
    if (isProdTesting(testing)) {
        return null;
    }
    const raw = testing !== undefined && testing !== null && testing !== "" ? testing : defaultTestingFromEnv();
    if (!raw) {
        return null;
    }
    return normalizeTestingEnv(raw);
};
