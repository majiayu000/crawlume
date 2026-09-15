import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { workerSigningPayload } from "../control-plane/worker-challenge-budget.js";

const workerChallengePattern = /^dya_wc_[A-Za-z0-9_-]{43}$/u;

export class RemoteWorkerIdentityError extends Error {
  constructor() {
    super("The Remote Worker identity or Session signing payload is invalid.");
    this.name = "RemoteWorkerIdentityError";
  }
}

export class InMemoryWorkerIdentity {
  readonly publicKeySpki: string;
  readonly #privateKey: KeyObject;

  private constructor(privateKey: KeyObject, publicKeySpki: string) {
    this.#privateKey = privateKey;
    this.publicKeySpki = publicKeySpki;
    Object.freeze(this);
  }

  static generate(): InMemoryWorkerIdentity {
    const keys = generateKeyPairSync("ed25519");
    const publicKeySpki = keys.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url");
    return new InMemoryWorkerIdentity(keys.privateKey, publicKeySpki);
  }

  static fromPkcs8Der(pkcs8Der: Uint8Array): InMemoryWorkerIdentity {
    const serialized = Buffer.from(pkcs8Der);
    try {
      const privateKey = createPrivateKey({
        key: serialized,
        format: "der",
        type: "pkcs8",
      });
      if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
        throw new RemoteWorkerIdentityError();
      }
      const canonical = privateKey.export({ format: "der", type: "pkcs8" });
      try {
        if (!canonical.equals(serialized)) throw new RemoteWorkerIdentityError();
      } finally {
        canonical.fill(0);
      }
      const publicKey = createPublicKey(privateKey);
      if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
        throw new RemoteWorkerIdentityError();
      }
      return new InMemoryWorkerIdentity(
        privateKey,
        publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      );
    } catch {
      throw new RemoteWorkerIdentityError();
    } finally {
      serialized.fill(0);
    }
  }

  signSessionChallenge(challenge: string, signingPayload: string): string {
    if (
      !workerChallengePattern.test(challenge) ||
      signingPayload !== workerSigningPayload(challenge) ||
      this.#privateKey.type !== "private" ||
      this.#privateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new RemoteWorkerIdentityError();
    }
    const signature = sign(null, Buffer.from(signingPayload, "utf8"), this.#privateKey);
    const encoded = signature.toString("base64url");
    if (signature.byteLength !== 64 || !/^[A-Za-z0-9_-]{86}$/u.test(encoded)) {
      throw new RemoteWorkerIdentityError();
    }
    return encoded;
  }
}

export function createInMemoryWorkerIdentity(): InMemoryWorkerIdentity {
  return InMemoryWorkerIdentity.generate();
}
