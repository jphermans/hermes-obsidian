/**
 * A strictly serial queue: one job runs at a time, in the order it was asked for.
 * A second command launched while one is running waits instead of colliding with
 * it, and a failing job never stops the ones behind it.
 */

export interface QueueEntry {
  id: string;
  label: string;
}

interface Job {
  id: string;
  label: string;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class SerialQueue {
  private jobs: Job[] = [];
  private active: Job | null = null;
  private counter = 0;
  private listeners: (() => void)[] = [];

  /** Runs after the current job and after anything already waiting. */
  run<T>(label: string, task: () => Promise<T>): Promise<T> {
    this.counter++;
    const id = "job-" + this.counter;
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({
        id,
        label,
        run: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.notify();
      void this.pump();
    });
  }

  /** Jobs that are waiting, not the one currently running. */
  waiting(): QueueEntry[] {
    return this.jobs.map((job) => ({ id: job.id, label: job.label }));
  }

  activeLabel(): string | null {
    return this.active ? this.active.label : null;
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  /** Drops a job that has not started yet. The running one is never interrupted. */
  cancel(id: string): boolean {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index < 0) return false;
    const [job] = this.jobs.splice(index, 1);
    job.reject(new Error("Cancelled before it started."));
    this.notify();
    return true;
  }

  cancelWaiting(): number {
    const cancelled = this.jobs.length;
    for (const job of this.jobs) job.reject(new Error("Cancelled before it started."));
    this.jobs = [];
    this.notify();
    return cancelled;
  }

  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners.slice()) listener();
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.active = job;
    this.notify();
    try {
      job.resolve(await job.run());
    } catch (error) {
      job.reject(error);
    } finally {
      this.active = null;
      this.notify();
      // Keep draining: a failure must not strand the queue.
      if (this.jobs.length > 0) void this.pump();
    }
  }
}
