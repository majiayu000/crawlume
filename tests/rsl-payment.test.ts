import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { evaluateRslPayment } from "../src/rsl-payment.js";

const namespace = "https://rslstandard.org/rsl";

function license(body: string): Element {
  const document = new JSDOM(
    `<license xmlns="${namespace}">${body}</license>`,
    { contentType: "application/xml" },
  ).window.document;
  return document.documentElement;
}

describe("evaluateRslPayment", () => {
  it("returns a declared fixed-decimal quote without executing it", () => {
    expect(evaluateRslPayment(license(
      '<payment type="purchase"><amount currency="USD">12.50</amount></payment>',
    ))).toEqual({
      outcome: "payment",
      obligations: [],
      quote: {
        paymentType: "purchase",
        paymentAmount: "12.50",
        paymentCurrency: "USD",
        paymentProtocols: [],
        pricingAuthority: "declared",
      },
    });
  });

  it("treats x402 instructions as opaque runtime pricing metadata", () => {
    const result = evaluateRslPayment(license(`
      <payment type="crawl">
        <amount currency="USD">0.01</amount>
        <accepts type="application/x402+json"><![CDATA[
          {"scheme":"exact","payTo":"do-not-execute"}
        ]]></accepts>
      </payment>
    `));

    expect(result).toMatchObject({
      outcome: "payment",
      quote: {
        paymentType: "crawl",
        paymentAmount: "0.01",
        paymentCurrency: "USD",
        paymentProtocols: ["application/x402+json"],
        pricingAuthority: "runtime",
      },
    });
    expect(JSON.stringify(result)).not.toContain("do-not-execute");
  });

  it("preserves free attribution as a confirmation obligation", () => {
    expect(evaluateRslPayment(license(`
      <payment type="attribution">
        <standard>https://creativecommons.org/licenses/by/4.0/</standard>
      </payment>
    `))).toEqual({
      outcome: "confirmation",
      obligations: [
        "attribution",
        "standard:https://creativecommons.org/licenses/by/4.0/",
      ],
      quote: null,
    });
  });

  it("accepts a bounded custom licensing URL only as a blocked process", () => {
    expect(evaluateRslPayment(license(
      '<payment type="subscription"><custom>/licensing/subscribe</custom></payment>',
    ))).toMatchObject({
      outcome: "payment",
      quote: { paymentType: "subscription", pricingAuthority: "unspecified" },
    });
  });

  it.each([
    ["multiple payment elements", '<payment type="free"/><payment type="free"/>'],
    ["multiple amounts", '<payment type="purchase"><amount currency="USD">1</amount><amount currency="USD">2</amount></payment>'],
    ["lowercase currency", '<payment type="purchase"><amount currency="usd">1</amount></payment>'],
    ["zero amount", '<payment type="purchase"><amount currency="USD">0.00</amount></payment>'],
    ["exponent amount", '<payment type="purchase"><amount currency="USD">1e3</amount></payment>'],
    ["unbounded precision", `<payment type="purchase"><amount currency="USD">1.${"1".repeat(19)}</amount></payment>`],
    ["missing protocol type", '<payment type="crawl"><accepts>{}</accepts></payment>'],
    ["invalid protocol type", '<payment type="crawl"><accepts type="not a media type">{}</accepts></payment>'],
    ["too many protocols", `<payment type="crawl">${'<accepts type="application/json"/>'.repeat(17)}</payment>`],
    ["unsafe custom process", '<payment type="purchase"><custom>javascript:alert(1)</custom></payment>'],
    ["unsupported payment type", '<payment type="surprise"/>'],
  ])("rejects malformed %s", (_name, body) => {
    expect(() => evaluateRslPayment(license(body))).toThrow();
  });
});
