import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { verify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";

import { loadConfig } from "../src/config.js";
import { AgentIdentity, agentIdentityEvidence } from "../src/identity.js";
import { testConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

function privateJwkFile(mode = 0o600): { path: string; publicJwk: JsonWebKey } {
  const directory = mkdtempSync(join(tmpdir(), "diaoyan-identity-test-"));
  temporaryDirectories.push(directory);
  const pair = generateKeyPairSync("ed25519");
  const privateJwk = pair.privateKey.export({ format: "jwk" });
  const path = join(directory, "private.jwk.json");
  writeFileSync(path, JSON.stringify(privateJwk), { mode });
  return { path, publicJwk: pair.publicKey.export({ format: "jwk" }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AgentIdentity", () => {
  it("leaves headers unchanged when signing is disabled", () => {
    const identity = new AgentIdentity(testConfig());
    const base = { "user-agent": "DiaoyanWebReaderTest/0.1" };

    expect(identity.headers(new URL("https://example.com/article"), base)).toBe(base);
    expect(identity.evidence()).toEqual({
      userAgent: "DiaoyanWebReaderTest/0.1",
      identityUrl: null,
      signed: false,
      profile: null,
    });
  });

  it("creates a verifiable Cloudflare-compatible signature for the request authority", async () => {
    const key = privateJwkFile();
    const config = {
      ...testConfig(),
      agentIdentityUrl: "https://crawler.example/identity",
      webBotAuthJwkPath: key.path,
      webBotAuthTtlSeconds: 60,
    };
    const identity = new AgentIdentity(config);
    const target = new URL("https://example.com/article");
    const headers = identity.headers(target, { "user-agent": config.userAgent });

    expect(headers["signature-agent"]).toBe('"https://crawler.example/identity"');
    expect(headers["signature-input"]).toContain('("@authority" "signature-agent")');
    expect(headers["signature-input"]).toContain('tag="web-bot-auth"');
    expect(headers.signature).toMatch(/^sig1=:/);
    await expect(
      verify(new Request(target, { headers }), await verifierFromJWK(key.publicJwk)),
    ).resolves.toBeUndefined();
    expect(identity.evidence()).toEqual({
      userAgent: config.userAgent,
      identityUrl: config.agentIdentityUrl,
      signed: true,
      profile: "cloudflare-legacy",
    });
  });

  it("requires a fresh signature when a redirect changes authority", async () => {
    const key = privateJwkFile();
    const config = {
      ...testConfig(),
      agentIdentityUrl: "https://crawler.example/identity",
      webBotAuthJwkPath: key.path,
    };
    const identity = new AgentIdentity(config);
    const first = new URL("https://first.example/article");
    const redirected = new URL("https://second.example/article");
    const firstHeaders = identity.headers(first, { "user-agent": config.userAgent });
    const redirectedHeaders = identity.headers(redirected, { "user-agent": config.userAgent });
    const verifier = await verifierFromJWK(key.publicJwk);

    await expect(verify(new Request(first, { headers: firstHeaders }), verifier)).resolves.toBeUndefined();
    await expect(
      verify(new Request(redirected, { headers: firstHeaders }), verifier),
    ).rejects.toThrow();
    await expect(
      verify(new Request(redirected, { headers: redirectedHeaders }), verifier),
    ).resolves.toBeUndefined();
  });

  it("rejects a private key file readable by other users", () => {
    const key = privateJwkFile(0o644);
    const config = {
      ...testConfig(),
      agentIdentityUrl: "https://crawler.example/identity",
      webBotAuthJwkPath: key.path,
    };

    expect(() => new AgentIdentity(config)).toThrow(
      "must not be accessible by group or other users",
    );
  });

  it("reports browser-style unsigned evidence without claiming a signing profile", () => {
    const config = {
      ...testConfig(),
      agentIdentityUrl: "https://crawler.example/identity",
    };

    expect(agentIdentityEvidence(config, false)).toEqual({
      userAgent: config.userAgent,
      identityUrl: config.agentIdentityUrl,
      signed: false,
      profile: null,
    });
  });
});

describe("Agent identity configuration", () => {
  it("requires an HTTPS identity without credentials, query, or fragment", () => {
    vi.stubEnv("DIAOYAN_AGENT_IDENTITY_URL", "http://crawler.example/?token=secret");

    expect(() => loadConfig()).toThrow(
      "must be HTTPS and must not contain credentials, query, or fragment",
    );
  });

  it("requires an identity URL when a private key path is configured", () => {
    vi.stubEnv("DIAOYAN_AGENT_IDENTITY_URL", "");
    vi.stubEnv("DIAOYAN_WEB_BOT_AUTH_JWK_PATH", "/tmp/private.jwk.json");

    expect(() => loadConfig()).toThrow("DIAOYAN_AGENT_IDENTITY_URL is required");
  });

  it("rejects unsupported compatibility profiles", () => {
    vi.stubEnv("DIAOYAN_WEB_BOT_AUTH_PROFILE", "ietf-draft-2026");

    expect(() => loadConfig()).toThrow(
      "DIAOYAN_WEB_BOT_AUTH_PROFILE must be cloudflare-legacy",
    );
  });
});
