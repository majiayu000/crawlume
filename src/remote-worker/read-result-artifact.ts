import { createHash } from "node:crypto";

import type { ReadPageResult } from "../types.js";

const mediaType = "application/vnd.diaoyan.public-read-result+json;version=1";

export type PublicReadResultArtifact = Readonly<{
  bytes: Uint8Array;
  contentHash: string;
  byteCount: number;
  mediaType: typeof mediaType;
  completeness: "complete" | "partial";
  storage: "worker_local";
}>;

export class PublicReadResultArtifactError extends Error {
  constructor() {
    super("The public read result cannot be encoded as an artifact.");
    this.name = "PublicReadResultArtifactError";
  }
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftCodePoints = [...left];
  const rightCodePoints = [...right];
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCodePoints[index]!.codePointAt(0)!;
    const rightCodePoint = rightCodePoints[index]!.codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function encodeJson(
  value: unknown,
  ancestors: WeakSet<object>,
  omittedKeys: ReadonlySet<string> = new Set<string>(),
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PublicReadResultArtifactError();
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new PublicReadResultArtifactError();
  if (ancestors.has(value)) throw new PublicReadResultArtifactError();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new PublicReadResultArtifactError();
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new PublicReadResultArtifactError();
      }
      const entries: string[] = [];
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
        throw new PublicReadResultArtifactError();
      }
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.value === undefined
        ) {
          throw new PublicReadResultArtifactError();
        }
        entries.push(encodeJson(descriptor.value, ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PublicReadResultArtifactError();
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new PublicReadResultArtifactError();
    }

    const entries: string[] = [];
    const keys = Object.keys(value).sort(compareUnicodeCodePoints);
    for (const key of keys) {
      if (omittedKeys.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new PublicReadResultArtifactError();
      }
      if (descriptor.value === undefined) continue;
      const childOmissions = key === "evidence" && omittedKeys.has("cached")
        ? new Set(["cacheStatus"])
        : undefined;
      entries.push(`${JSON.stringify(key)}:${encodeJson(
        descriptor.value,
        ancestors,
        childOmissions,
      )}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function encodePublicReadResultArtifact(
  result: ReadPageResult,
): PublicReadResultArtifact {
  try {
    const completenessDescriptor = Object.getOwnPropertyDescriptor(result, "completeness");
    if (completenessDescriptor === undefined || !("value" in completenessDescriptor)) {
      throw new PublicReadResultArtifactError();
    }
    const completeness = completenessDescriptor.value === "complete"
      ? "complete"
      : completenessDescriptor.value === "uncertain"
        ? "partial"
        : undefined;
    if (completeness === undefined) throw new PublicReadResultArtifactError();

    const encodedResult = encodeJson(result, new WeakSet(), new Set(["cached"]));
    const json = `{"result":${encodedResult},"schema":"diaoyan.public-read-result","version":1}`;
    const canonicalBytes = Buffer.from(json, "utf8");
    return Object.freeze({
      get bytes() {
        return Uint8Array.from(canonicalBytes);
      },
      contentHash: createHash("sha256").update(canonicalBytes).digest("base64url"),
      byteCount: canonicalBytes.byteLength,
      mediaType,
      completeness,
      storage: "worker_local" as const,
    });
  } catch {
    throw new PublicReadResultArtifactError();
  }
}
