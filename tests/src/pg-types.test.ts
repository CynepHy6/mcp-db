import { pgTypeParser } from "../../src/clients/postgres-session";

describe("pg type parsing with the real driver", () => {
    it("keeps interval as the server text", () => {
        expect(pgTypeParser(1186)("-00:00:00.009614")).toBe("-00:00:00.009614");
    });

    it("parses date, timestamptz and interval arrays into server strings", () => {
        expect(pgTypeParser(1182)("{2026-10-16,2026-10-17}")).toEqual(["2026-10-16", "2026-10-17"]);
        expect(pgTypeParser(1185)('{"2026-10-16 08:00:00+00"}')).toEqual(["2026-10-16 08:00:00+00"]);
        expect(pgTypeParser(1187)('{"1 day",00:00:01}')).toEqual(["1 day", "00:00:01"]);
    });
});
