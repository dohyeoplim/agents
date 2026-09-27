export class SerialQueue {
    pending = 0;
    tail = Promise.resolve();
    run(fn) {
        if (this.pending >= 32) return Promise.reject(Error("Queue full"));
        this.pending++;
        const next = this.tail.then(fn);
        this.tail = next.catch(() => {}).finally(() => this.pending--);
        return next;
    }
}
