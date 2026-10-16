export class Semaphore {
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(readonly limit: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((resolve) => this.waiters.push(resolve));
        } else {
            this.active += 1;
        }
        try {
            return await task();
        } finally {
            const next = this.waiters.shift();
            if (next) {
                next();
            } else {
                this.active -= 1;
            }
        }
    }
}

/** Runs tasks with at most `limit` in flight; results keep the input order. */
export const mapWithConcurrency = async <T, R>(
    items: T[],
    limit: number,
    task: (item: T) => Promise<R>,
): Promise<R[]> => {
    const semaphore = new Semaphore(Math.max(1, limit));
    return Promise.all(items.map((item) => semaphore.run(() => task(item))));
};
