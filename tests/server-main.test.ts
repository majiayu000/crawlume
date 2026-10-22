import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appClose: vi.fn(),
  metricsClose: vi.fn(),
  serverClose: vi.fn(),
  connect: vi.fn(),
  protocol: { onclose: undefined as (() => void) | undefined },
}));
vi.mock("../src/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../src/app.js", () => ({ createApp: () => ({ close: mocks.appClose, metrics: {} }) }));
vi.mock("../src/mcp.js", () => ({ createMcpServer: () => ({
  server: mocks.protocol, close: mocks.serverClose, connect: mocks.connect,
}) }));
vi.mock("../src/metrics-server.js", () => ({
  metricsListenerFromEnvironment: () => ({ host: "127.0.0.1", port: 0 }),
  startMetricsListener: async () => ({ origin: "http://127.0.0.1:9464", close: mocks.metricsClose }),
}));
import { main } from "../src/server.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.protocol.onclose = undefined;
  mocks.appClose.mockResolvedValue(undefined);
  mocks.metricsClose.mockResolvedValue(undefined);
  mocks.serverClose.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue(undefined);
});
afterEach(async () => {
  if (mocks.appClose.mock.calls.length === 0) mocks.protocol.onclose?.();
  await vi.waitFor(() => expect(mocks.appClose).toHaveBeenCalledTimes(1));
  process.exitCode = undefined;
});

describe("MCP resource cleanup", () => {
  it("closes metrics and the app on stdin EOF without a signal", async () => {
    await main({});
    process.stdin.emit("end");
    await vi.waitFor(() => expect(mocks.appClose).toHaveBeenCalledTimes(1));
    expect(mocks.metricsClose).toHaveBeenCalledTimes(1);
    expect(mocks.serverClose).toHaveBeenCalledTimes(1);
  });

  it("closes resources when the MCP server closes", async () => {
    await main({});
    mocks.protocol.onclose?.();
    await vi.waitFor(() => expect(mocks.appClose).toHaveBeenCalledTimes(1));
    expect(mocks.metricsClose).toHaveBeenCalledTimes(1);
  });

  it("cleans up metrics after a connection failure", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("connection failed"));
    await expect(main({})).rejects.toThrow("connection failed");
    expect(mocks.metricsClose).toHaveBeenCalledTimes(1);
    expect(mocks.appClose).toHaveBeenCalledTimes(1);
  });

  it("continues cleanup if closing the metrics listener fails", async () => {
    mocks.metricsClose.mockRejectedValueOnce(new Error("metrics close failed"));
    mocks.connect.mockRejectedValueOnce(new Error("connection failed"));
    await expect(main({})).rejects.toThrow("MCP connection and cleanup both failed");
    expect(mocks.serverClose).toHaveBeenCalledTimes(1);
    expect(mocks.appClose).toHaveBeenCalledTimes(1);
  });
});
