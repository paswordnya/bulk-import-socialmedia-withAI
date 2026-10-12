/** Minimal in-process queue. Jobs are durable in the DB; startup re-enqueues PENDING ones. */
export class JobQueue {
  private readonly pending: string[] = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly handler: (jobId: string) => Promise<void>,
    private readonly concurrency = 2,
  ) {}

  enqueue(jobId: string): void {
    this.pending.push(jobId);
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift()!;
      this.running++;
      this.handler(id)
        .catch(() => {})
        .finally(() => {
          this.running--;
          this.pump();
          if (this.running === 0 && this.pending.length === 0) this.idleWaiters.splice(0).forEach((r) => r());
        });
    }
  }

  onIdle(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
}
