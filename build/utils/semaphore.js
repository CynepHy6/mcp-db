export class Semaphore {
    constructor(limit) {
        this.limit = limit;
        this.active = 0;
        this.waiters = [];
    }
    async run(task) {
        if (this.active >= this.limit) {
            await new Promise((resolve) => this.waiters.push(resolve));
        }
        else {
            this.active += 1;
        }
        try {
            return await task();
        }
        finally {
            const next = this.waiters.shift();
            if (next) {
                next();
            }
            else {
                this.active -= 1;
            }
        }
    }
}
/** Runs tasks with at most `limit` in flight; results keep the input order. */
export const mapWithConcurrency = async (items, limit, task) => {
    const semaphore = new Semaphore(Math.max(1, limit));
    return Promise.all(items.map((item) => semaphore.run(() => task(item))));
};
