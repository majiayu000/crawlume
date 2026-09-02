import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createHttpServer: vi.fn(),
  closeListener: vi.fn(),
  endPool: vi.fn(),
  events: [] as string[],
  fatalHandler: undefined as ((error: unknown) => void) | undefined,
  serverErrorHandler: undefined as ((error: Error) => void) | undefined,
  listen: vi.fn(),
  poolQuery: vi.fn(),
  recoverExpiredJobLeases: vi.fn(),
  closeSweepRunner: vi.fn(),
  startSweepRunner: vi.fn(),
  runMigrations: vi.fn(),
}));

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, createServer: mocks.createHttpServer };
});

vi.mock("pg", () => ({
  Pool: class {
    on(): this {
      return this;
    }

    async end(): Promise<void> {
      mocks.events.push("database");
      await mocks.endPool();
    }

    async query(): Promise<{ rows: unknown[] }> {
      return mocks.poolQuery();
    }
  },
}));

vi.mock("../src/control-plane/migrations.js", () => ({
  runControlPlaneMigrations: mocks.runMigrations,
}));

vi.mock("../src/control-plane/job-lease-recovery.js", () => ({
  ControlPlaneJobLeaseSweeper: class {},
  ControlPlaneJobLeaseSweepRunner: class {
    constructor(
      _sweeper: unknown,
      options: Readonly<{ onFatalError(error: unknown): void }>,
    ) {
      mocks.fatalHandler = options.onFatalError;
    }

    async start(): Promise<number> {
      mocks.events.push("sweep-start");
      return mocks.startSweepRunner();
    }

    async close(): Promise<void> {
      mocks.events.push("sweeper");
      await mocks.closeSweepRunner();
    }
  },
  recoverExpiredJobLeases: mocks.recoverExpiredJobLeases,
}));

import { controlPlaneMain, startControlPlaneRuntime } from "../src/server.js";

const temporaryDirectories: string[] = [];

describe("control-plane runtime startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.fatalHandler = undefined;
    mocks.serverErrorHandler = undefined;
    mocks.runMigrations.mockImplementation(async () => {
      mocks.events.push("migrations");
    });
    mocks.poolQuery.mockImplementation(async () => {
      mocks.events.push("readiness");
      return { rows: [] };
    });
    mocks.startSweepRunner.mockResolvedValue(0);
    mocks.closeSweepRunner.mockResolvedValue(undefined);
    mocks.endPool.mockResolvedValue(undefined);
    mocks.closeListener.mockImplementation((closed: (error?: Error) => void) => closed());
    mocks.listen.mockImplementation((listening: () => void) => listening());
    const server = {
      maxHeadersCount: 0,
      headersTimeout: 0,
      requestTimeout: 0,
      keepAliveTimeout: 0,
      on: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === "error") mocks.serverErrorHandler = handler;
        return server;
      }),
      once: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      listen: vi.fn((_port: number, _host: string, listening: () => void) => {
        mocks.events.push("listener-start");
        mocks.listen(listening);
        return server;
      }),
      address: vi.fn(() => ({ address: "127.0.0.1", family: "IPv4", port: 3210 })),
      closeAllConnections: vi.fn(),
      close: vi.fn((closed: (error?: Error) => void) => {
        mocks.events.push("listener");
        mocks.closeListener(closed);
      }),
    };
    mocks.createHttpServer.mockReturnValue(server);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  async function runtimeConfig() {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    return {
      database: {},
      identity: {
        sessionTokenIssuer: "https://control.example.test",
        sessionTokenAudience: "worker",
        sessionTokenPrivateKey: privateKey,
        sessionTokenPublicKey: publicKey,
      },
      listener: { host: "127.0.0.1", port: 0, tls: null },
    } as const;
  }

  async function runtimeEnvironment(): Promise<NodeJS.ProcessEnv> {
    const directory = await mkdtemp(join(tmpdir(), "diaoyan-control-runtime-"));
    temporaryDirectories.push(directory);
    const privateKeyPath = join(directory, "session-private.pem");
    const publicKeyPath = join(directory, "session-public.pem");
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
    await writeFile(privateKeyPath, await exportPKCS8(privateKey), { mode: 0o600 });
    await writeFile(publicKeyPath, await exportSPKI(publicKey), { mode: 0o644 });
    return {
      DIAOYAN_CONTROL_DATABASE_URL: "postgresql://runtime:runtime@127.0.0.1:5432/runtime",
      DIAOYAN_CONTROL_HOST: "127.0.0.1",
      DIAOYAN_CONTROL_PORT: "0",
      DIAOYAN_WORKER_SESSION_ISSUER: "https://control.example.test",
      DIAOYAN_WORKER_SESSION_AUDIENCE: "worker",
      DIAOYAN_WORKER_SESSION_PRIVATE_KEY_PATH: privateKeyPath,
      DIAOYAN_WORKER_SESSION_PUBLIC_KEY_PATH: publicKeyPath,
    };
  }

  it("closes PostgreSQL without starting a listener when migration fails", async () => {
    const migrationError = new Error("migration failed");
    mocks.runMigrations.mockRejectedValueOnce(migrationError);

    await expect(startControlPlaneRuntime(await runtimeConfig())).rejects.toBe(migrationError);

    expect(mocks.createHttpServer).not.toHaveBeenCalled();
    expect(mocks.endPool).toHaveBeenCalledOnce();
  });

  it("does not start a listener when the initial lease sweep fails", async () => {
    const sweepError = new Error("initial sweep failed");
    mocks.startSweepRunner.mockImplementationOnce(async () => {
      mocks.fatalHandler?.(sweepError);
      throw sweepError;
    });

    await expect(startControlPlaneRuntime(await runtimeConfig())).rejects.toBe(sweepError);

    expect(mocks.createHttpServer).not.toHaveBeenCalled();
    expect(mocks.closeSweepRunner).toHaveBeenCalledOnce();
    expect(mocks.endPool).toHaveBeenCalledOnce();
  });

  it("propagates an undefined periodic fatal reason through controlPlaneMain and shuts down", async () => {
    const running = controlPlaneMain(await runtimeEnvironment());
    await vi.waitFor(() => expect(mocks.createHttpServer).toHaveBeenCalledOnce());

    mocks.fatalHandler?.(undefined);

    await expect(running).rejects.toBeUndefined();
    expect(mocks.events.slice(-3)).toEqual(["listener", "sweeper", "database"]);
  });

  it("starts sweeping before listening and closes listener, sweeper, then database", async () => {
    const runtime = await startControlPlaneRuntime(await runtimeConfig());
    expect(mocks.events.slice(0, 4)).toEqual([
      "migrations",
      "readiness",
      "sweep-start",
      "listener-start",
    ]);

    const finished = runtime.finished;
    await runtime.close();

    await expect(finished).resolves.toBeUndefined();
    expect(mocks.events.slice(-3)).toEqual(["listener", "sweeper", "database"]);
  });

  it("closes once for concurrent callers", async () => {
    let releaseSweepClose!: () => void;
    const sweepClosing = new Promise<void>((resolve) => { releaseSweepClose = resolve; });
    mocks.closeSweepRunner.mockReturnValueOnce(sweepClosing);
    const runtime = await startControlPlaneRuntime(await runtimeConfig());

    const first = runtime.close();
    const second = runtime.close();
    expect(second).toBe(first);
    expect(mocks.closeListener).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.closeSweepRunner).toHaveBeenCalledOnce());

    releaseSweepClose();
    await Promise.all([first, second]);
    expect(mocks.closeListener).toHaveBeenCalledOnce();
    expect(mocks.endPool).toHaveBeenCalledOnce();
  });

  it("tries every close step and preserves all close failures", async () => {
    const sweepError = new Error("sweeper close failed");
    const listenerError = new Error("listener close failed");
    const databaseError = new Error("database close failed");
    mocks.closeSweepRunner.mockRejectedValueOnce(sweepError);
    mocks.closeListener.mockImplementationOnce((closed: (error?: Error) => void) => {
      closed(listenerError);
    });
    mocks.endPool.mockRejectedValueOnce(databaseError);
    const runtime = await startControlPlaneRuntime(await runtimeConfig());

    const closing = runtime.close();
    await expect(closing).rejects.toMatchObject({
      errors: [listenerError, sweepError, databaseError],
    });
    expect(mocks.events.slice(-3)).toEqual(["listener", "sweeper", "database"]);
  });

  it("handles a signal by closing and resolving the main runtime", async () => {
    const once = vi.spyOn(process, "once");
    const running = controlPlaneMain(await runtimeEnvironment());
    await vi.waitFor(() => expect(mocks.createHttpServer).toHaveBeenCalledOnce());
    const signalHandler = once.mock.calls.find(([event]) => event === "SIGINT")?.[1];
    expect(signalHandler).toBeTypeOf("function");

    Reflect.apply(signalHandler!, process, []);

    await expect(running).resolves.toBeUndefined();
    expect(mocks.events.slice(-3)).toEqual(["listener", "sweeper", "database"]);
  });

  it("preserves both a periodic fatal error and a shutdown failure", async () => {
    const closeError = new Error("sweeper close failed");
    mocks.closeSweepRunner.mockRejectedValueOnce(closeError);
    const running = controlPlaneMain(await runtimeEnvironment());
    await vi.waitFor(() => expect(mocks.createHttpServer).toHaveBeenCalledOnce());
    const fatalError = new Error("periodic sweep failed");

    mocks.fatalHandler?.(fatalError);

    await expect(running).rejects.toMatchObject({ errors: [fatalError, closeError] });
  });

  it("fails startup on an undefined fatal reason while the listener is binding", async () => {
    let finishListening!: () => void;
    mocks.listen.mockImplementationOnce((listening: () => void) => {
      finishListening = listening;
    });
    const starting = startControlPlaneRuntime(await runtimeConfig());
    await vi.waitFor(() => expect(mocks.events).toContain("listener-start"));
    mocks.fatalHandler?.(undefined);
    finishListening();

    await expect(starting).rejects.toBeUndefined();
    expect(mocks.events.slice(-3)).toEqual(["listener", "sweeper", "database"]);
  });

  it("reports listener failures through the runtime fatal channel", async () => {
    const runtime = await startControlPlaneRuntime(await runtimeConfig());
    const listenerError = new Error("listener failed");

    mocks.serverErrorHandler?.(listenerError);

    await expect(runtime.finished).rejects.toBe(listenerError);
    await runtime.close();
  });
});
