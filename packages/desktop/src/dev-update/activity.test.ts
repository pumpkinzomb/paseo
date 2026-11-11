import { describe, expect, it } from "vitest";
import { UpdateActivityGate } from "./activity.js";
describe("update operation admission", () => {
  it("counts complete async operations, rejects new work while sealed and reopens on abort", async () => {
    const gate = new UpdateActivityGate();
    let finish!: () => void;
    const work = gate.run(
      "automation",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(gate.seal()).toBe(false);
    await expect(gate.run("late", async () => {})).rejects.toThrow("checkpoint");
    expect(gate.inFlight).toBe(1);
    finish();
    await work;
    expect(gate.inFlight).toBe(0);
    expect(gate.epoch).toBe(2);
    gate.release();
    await expect(gate.run("new", async () => 42)).resolves.toBe(42);
  });
  it("releases in-flight accounting even when commands or cleanup reject", async () => {
    const gate = new UpdateActivityGate();
    await expect(
      gate.run("failure", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(gate.inFlight).toBe(0);
    expect(gate.seal()).toBe(true);
  });
});
