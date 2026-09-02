import { generateKeyPair } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createHttpServer: vi.fn(),
  endPool: vi.fn(),
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
      mocks.endPool();
    }
  },
}));

vi.mock("../src/control-plane/migrations.js", () => ({
  runControlPlaneMigrations: mocks.runMigrations,
}));

import { startControlPlaneRuntime } from "../src/server.js";

describe("control-plane runtime startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes PostgreSQL without starting a listener when migration fails", async () => {
    const migrationError = new Error("migration failed");
    mocks.runMigrations.mockRejectedValueOnce(migrationError);
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");

    await expect(startControlPlaneRuntime({
      database: {},
      identity: {
        sessionTokenIssuer: "https://control.example.test",
        sessionTokenAudience: "worker",
        sessionTokenPrivateKey: privateKey,
        sessionTokenPublicKey: publicKey,
      },
      listener: { host: "127.0.0.1", port: 0, tls: null },
    })).rejects.toBe(migrationError);

    expect(mocks.createHttpServer).not.toHaveBeenCalled();
    expect(mocks.endPool).toHaveBeenCalledOnce();
  });
});
