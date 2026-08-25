import { describe, expect, it } from "vitest";

import { ReadError } from "../src/errors.js";
import { isDnsFakeIpAddress, isPublicAddress, UrlPolicy } from "../src/security/url-policy.js";

describe("UrlPolicy", () => {
  it.each([
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
  ])("blocks non-public literal address %s", async (input) => {
    const policy = new UrlPolicy(async () => []);
    await expect(policy.assertPublic(policy.parse(input))).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    } satisfies Partial<ReadError>);
  });

  it("blocks a hostname resolving to a private address", async () => {
    const policy = new UrlPolicy(async () => [{ address: "192.168.1.4", family: 4 }]);
    await expect(policy.assertPublic(policy.parse("https://internal.example/"))).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
  });

  it("accepts a public hostname", async () => {
    const policy = new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]);
    await expect(policy.assertPublic(policy.parse("https://example.com/"))).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  it("supports opt-in DNS fake-IP results without allowing literal fake-IP URLs", async () => {
    const policy = new UrlPolicy(
      async () => [{ address: "198.18.2.5", family: 4 }],
      true,
    );
    await expect(policy.assertPublic(policy.parse("https://example.com/"))).resolves.toEqual([
      { address: "198.18.2.5", family: 4 },
    ]);
    await expect(policy.assertPublic(policy.parse("http://198.18.2.5/"))).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
  });

  it("rejects DNS fake-IP results unless explicitly enabled", async () => {
    const policy = new UrlPolicy(async () => [{ address: "198.18.2.5", family: 4 }]);
    await expect(policy.assertPublic(policy.parse("https://example.com/"))).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
    expect(isDnsFakeIpAddress("198.18.2.5")).toBe(true);
  });

  it.each(["file:///etc/passwd", "https://user:secret@example.com/"])(
    "rejects unsupported or credential-bearing URL %s",
    (input) => {
      const policy = new UrlPolicy();
      expect(() => policy.parse(input)).toThrow(ReadError);
    },
  );

  it.each(["127.0.0.1", "::1", "10.0.0.1", "169.254.169.254", "0.0.0.0"])(
    "does not classify %s as public",
    (address) => expect(isPublicAddress(address)).toBe(false),
  );
});
