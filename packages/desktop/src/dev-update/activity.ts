/** One admission gate spans the entire asynchronous operation, including cleanup. */
export class UpdateActivityGate {
  epoch = 0;
  inFlight = 0;
  private sealed = false;
  onActivity: (reason: string) => void = () => {};
  activity(reason: string): void {
    this.epoch += 1;
    this.onActivity(reason);
  }
  seal(): boolean {
    this.sealed = true;
    return this.inFlight === 0;
  }
  release(): void {
    this.sealed = false;
  }
  async run<T>(reason: string, operation: () => Promise<T>): Promise<T> {
    if (this.sealed) throw new Error("Update checkpoint in progress; retry after it finishes.");
    this.inFlight += 1;
    this.activity(reason);
    try {
      return await operation();
    } finally {
      this.inFlight -= 1;
      this.activity(`${reason}:finished`);
    }
  }
}
export const updateActivity = new UpdateActivityGate();
