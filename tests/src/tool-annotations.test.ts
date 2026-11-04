// Аннотации MCP: у каждого зарегистрированного инструмента есть пометка, читающие помечены readOnlyHint.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TOOL_ANNOTATIONS, toolAnnotations } from "../../src/utils/tool-annotations";

const indexSource = readFileSync(join(__dirname, "../../src/index.ts"), "utf8");
const registered = [...indexSource.matchAll(/server\.tool\(\s*"([^"]+)",/g)].map((match) => match[1]);
// Каждый вызов регистрации обязан начинаться с имени-литерала: иначе он выпал бы из сверки выше.
const registrations = indexSource.match(/server\.tool\(/g) ?? [];

describe("tool annotations", () => {
    it("covers every registered tool and nothing else", () => {
        expect(registered.length).toBeGreaterThan(0);
        expect(registered.length).toBe(registrations.length);
        expect([...registered].sort()).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
    });

    it("passes annotations to every registration", () => {
        const blocks = indexSource.split(/server\.tool\(/).slice(1);
        expect(blocks.length).toBe(registered.length);
        for (const block of blocks) {
            const name = /^\s*"([^"]+)",/.exec(block)?.[1];
            expect(block.split("\n    );")[0]).toContain(`toolAnnotations("${name}")`);
        }
    });

    it("marks catalog and schema reads read-only", () => {
        for (const name of ["get_tables_schemas", "list_databases", "get_database_info"]) {
            expect(toolAnnotations(name).readOnlyHint).toBe(true);
        }
    });

    it("marks execute_query as a destructive write: testing stands accept any SQL", () => {
        expect(toolAnnotations("execute_query")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        const destructive = Object.entries(TOOL_ANNOTATIONS)
            .filter(([, annotations]) => annotations.destructiveHint)
            .map(([name]) => name);
        expect(destructive).toEqual(["execute_query"]);
    });

    it("refuses an unknown tool", () => {
        expect(() => toolAnnotations("no_such_tool")).toThrow(/no_such_tool/);
    });
});
