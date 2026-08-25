import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { platform } from "node:os";

import { signatureHeadersSync, type SignerSync } from "web-bot-auth";

import type { AppConfig } from "./config.js";
import type { AgentIdentityEvidence } from "./types.js";

type PrivateEd25519Jwk = JsonWebKey & {
  crv: "Ed25519";
  d: string;
  kty: "OKP";
  x: string;
};

function parsePrivateJwk(value: unknown): PrivateEd25519Jwk {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as JsonWebKey).kty !== "OKP" ||
    (value as JsonWebKey).crv !== "Ed25519" ||
    typeof (value as JsonWebKey).x !== "string" ||
    typeof (value as JsonWebKey).d !== "string" ||
    (value as JsonWebKey).x?.length === 0 ||
    (value as JsonWebKey).d?.length === 0
  ) {
    throw new Error("The Web Bot Auth JWK must be an Ed25519 private JWK with x and d fields.");
  }
  return value as PrivateEd25519Jwk;
}

function readPrivateJwk(path: string): PrivateEd25519Jwk {
  let file;
  try {
    file = statSync(path);
  } catch {
    throw new Error("The Web Bot Auth JWK file could not be inspected.");
  }
  if (!file.isFile()) {
    throw new Error("The Web Bot Auth JWK path must point to a regular file.");
  }
  if (platform() !== "win32" && (file.mode & 0o077) !== 0) {
    throw new Error("The Web Bot Auth JWK file must not be accessible by group or other users.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("The Web Bot Auth JWK file must contain valid JSON.");
  }
  return parsePrivateJwk(parsed);
}

function keyId(publicJwk: JsonWebKey): string {
  const canonical = JSON.stringify({
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
  });
  return createHash("sha256").update(canonical).digest("base64url");
}

function signerFor(jwk: PrivateEd25519Jwk): SignerSync {
  let privateKey: KeyObject;
  let publicJwk: JsonWebKey;
  try {
    privateKey = createPrivateKey({ format: "jwk", key: jwk });
    publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  } catch {
    throw new Error("The Web Bot Auth JWK could not be imported as an Ed25519 private key.");
  }
  if (publicJwk.kty !== "OKP" || publicJwk.crv !== "Ed25519" || publicJwk.x !== jwk.x) {
    throw new Error("The Web Bot Auth JWK public and private key material does not match.");
  }
  return {
    alg: "ed25519",
    keyid: keyId(publicJwk),
    signSync(data: string): Uint8Array {
      return sign(null, Buffer.from(data), privateKey);
    },
  };
}

export function agentIdentityEvidence(
  config: AppConfig,
  signed: boolean,
): AgentIdentityEvidence {
  return {
    userAgent: config.userAgent,
    identityUrl: config.agentIdentityUrl,
    signed,
    profile: signed ? config.webBotAuthProfile : null,
  };
}

export class AgentIdentity {
  private readonly signer: SignerSync | null;

  constructor(
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.signer =
      config.webBotAuthJwkPath === null ? null : signerFor(readPrivateJwk(config.webBotAuthJwkPath));
    if (this.signer !== null && config.agentIdentityUrl === null) {
      throw new Error("A public Agent identity URL is required when Web Bot Auth signing is enabled.");
    }
  }

  headers(url: URL, baseHeaders: Record<string, string>): Record<string, string> {
    if (this.signer === null) {
      return baseHeaders;
    }
    const identityUrl = this.config.agentIdentityUrl;
    if (identityUrl === null) {
      throw new Error("A public Agent identity URL is required when Web Bot Auth signing is enabled.");
    }
    const signatureAgent = JSON.stringify(identityUrl);
    const request = new Request(url, {
      method: "GET",
      headers: { ...baseHeaders, "signature-agent": signatureAgent },
    });
    const created = this.now();
    const signedHeaders = signatureHeadersSync(request, this.signer, {
      created,
      expires: new Date(created.getTime() + this.config.webBotAuthTtlSeconds * 1_000),
    });
    return {
      ...baseHeaders,
      "signature-agent": signatureAgent,
      "signature-input": signedHeaders["Signature-Input"],
      "signature": signedHeaders.Signature,
    };
  }

  evidence(): AgentIdentityEvidence {
    return agentIdentityEvidence(this.config, this.signer !== null);
  }
}
