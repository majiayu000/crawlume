import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

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
