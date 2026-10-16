/** JSON for tool output: bigint as text, binary as `\x…` hex, the rest as JSON.stringify would. */
export const toJson = (value: unknown): string =>
    JSON.stringify(
        value,
        function replacer(this: any, key: string, current: unknown) {
            const raw = this?.[key];
            if (Buffer.isBuffer(raw)) {
                return `\\x${raw.toString("hex")}`;
            }
            if (typeof current === "bigint") {
                return current.toString();
            }
            return current;
        },
        2,
    );

export const textContent = (text: string) => ({
    content: [{ type: "text" as const, text }],
});
