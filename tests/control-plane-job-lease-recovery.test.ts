import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlaneJobLeaseSweepRunner } from "../src/control-plane/job-lease-recovery.js";

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
}> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ControlPlaneJobLeaseSweepRunner", () => {
  it("runs immediately without a Worker claim and then follows the configured cadence", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const onFatalError = vi.fn();
    const runner = new ControlPlaneJobLeaseSweepRunner(
      { sweep },
      { intervalMs: 1_000, onFatalError },
    );

    await expect(runner.start()).resolves.toBe(2);
    expect(sweep).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(999);
    expect(sweep).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(onFatalError).not.toHaveBeenCalled();
    await runner.close();
  });

  it("rejects an initial failure through the fatal channel without scheduling", async () => {
    vi.useFakeTimers();
    const failure = new Error("initial lease sweep failed");
    const sweep = vi.fn().mockRejectedValue(failure);
    const onFatalError = vi.fn();
    const runner = new ControlPlaneJobLeaseSweepRunner(
      { sweep },
      { intervalMs: 100, onFatalError },
    );

    await expect(runner.start()).rejects.toBe(failure);
    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onFatalError).toHaveBeenCalledWith(failure);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledOnce();
    await runner.close();
  });

  it("close clears a pending sweep timer before it can run", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn().mockResolvedValue(0);
    const runner = new ControlPlaneJobLeaseSweepRunner(
      { sweep },
      { intervalMs: 100, onFatalError: vi.fn() },
    );

    await runner.start();
    expect(sweep).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await runner.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("does not schedule another sweep until the current sweep settles", async () => {
    vi.useFakeTimers();
    const firstSweep = deferred<number>();
    const sweep = vi.fn(() => firstSweep.promise);
    const runner = new ControlPlaneJobLeaseSweepRunner(
      { sweep },
      { intervalMs: 100, onFatalError: vi.fn() },
    );

    const started = runner.start();
    expect(sweep).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    firstSweep.resolve(1);
    await expect(started).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await runner.close();
  });

  it("reports a periodic failure through the fatal channel and stops scheduling", async () => {
    vi.useFakeTimers();
    const failure = new Error("lease sweep failed");
    const sweep = vi.fn()
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(failure);
    const onFatalError = vi.fn();
    const runner = new ControlPlaneJobLeaseSweepRunner(
      { sweep },
      { intervalMs: 100, onFatalError },
    );

    await runner.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onFatalError).toHaveBeenCalledWith(failure);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    await runner.close();
  });

  it("close clears future scheduling and waits for an in-flight sweep", async () => {
    vi.useFakeTimers();
    const periodicSweep = deferred<number>();
    const sweep = vi.fn()
      .mockResolvedValueOnce(0)
      .mockImplementationOnce(() => periodicSweep.promise);
    const runner = new ControlPlaneJobLeaseSweepRunner(
      { sweep },
      { intervalMs: 100, onFatalError: vi.fn() },
    );

    await runner.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(sweep).toHaveBeenCalledTimes(2);

    let closed = false;
    const closing = runner.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    periodicSweep.resolve(0);
    await closing;
    expect(closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
