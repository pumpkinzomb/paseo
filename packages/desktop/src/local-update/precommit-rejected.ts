/** Only emitted after this attempt's lock was released and no stop was attempted. */
export class PrecommitUpdateRejected extends Error {
  constructor(cause: unknown) {
    super("Update preparation was rejected before shutdown", { cause });
    this.name = "PrecommitUpdateRejected";
  }
}

/** Bounded public category; never expose controller paths or native errors. */
export class UpdateControlMismatch extends Error {
  constructor() {
    super("Exact daemon update transport unavailable");
    this.name = "UpdateControlMismatch";
  }
}
