/** Only emitted after this attempt's lock was released and no stop was attempted. */
export class PrecommitUpdateRejected extends Error {
  constructor(cause: unknown) {
    super("Update preparation was rejected before shutdown", { cause });
    this.name = "PrecommitUpdateRejected";
  }
}
