import { defaultTestingFromEnv } from "./env.js";

export const TESTING_ENV_PLACEHOLDER = "{{env}}";
/** Staging stands are s2, s6, … (no test- prefix); testing stands are test-yNN or free-form names. */
export const STAGING_ENV_PATTERN = /^s\d+$/;
/** qa-panel shortName of a personal stand (y10, y148): alias for test-yNN. */
export const PERSONAL_TESTING_SHORT_PATTERN = /^y\d+$/;

export const normalizeTestingEnv = (testing: string): string =>
    PERSONAL_TESTING_SHORT_PATTERN.test(testing) ? `test-${testing}` : testing;

/** test-alpha → alpha; without the test- prefix the suffix is the name itself. */
export const testingEnvSuffix = (testing: string): string =>
    testing.startsWith("test-") ? testing.slice("test-".length) : testing;

export const isStagingEnv = (testing: string): boolean => STAGING_ENV_PATTERN.test(testing);

/** Explicit testing wins; otherwise TESTING_NAME. An empty string counts as not set. */
export const coerceTesting = (testing?: string | null): string | null => {
    const raw = testing !== undefined && testing !== null && testing !== "" ? testing : defaultTestingFromEnv();
    if (!raw) {
        return null;
    }
    return normalizeTestingEnv(raw);
};
