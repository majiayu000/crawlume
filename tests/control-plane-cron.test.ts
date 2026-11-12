import { describe, expect, it } from "vitest";

import { CronExpressionError, nextCronTime, parseCronExpression } from "../src/control-plane/cron.js";

function next(expression: string, after: string): string | undefined {
  return nextCronTime(parseCronExpression(expression), new Date(after))?.toISOString();
}

describe("cron expressions", () => {
  it("finds the next matching UTC minute strictly after the given time", () => {
    expect(next("* * * * *", "2030-01-01T00:00:00.000Z")).toBe("2030-01-01T00:01:00.000Z");
    expect(next("*/15 * * * *", "2030-01-01T00:14:59.999Z")).toBe("2030-01-01T00:15:00.000Z");
    expect(next("*/15 * * * *", "2030-01-01T00:15:00.000Z")).toBe("2030-01-01T00:30:00.000Z");
    expect(next("30 9 * * mon-fri", "2030-01-04T10:00:00.000Z")).toBe("2030-01-07T09:30:00.000Z");
    expect(next("0 0 1 jan *", "2030-06-01T00:00:00.000Z")).toBe("2031-01-01T00:00:00.000Z");
    expect(next("0 12 29 2 *", "2030-03-01T00:00:00.000Z")).toBe("2032-02-29T12:00:00.000Z");
  });

  it("supports lists, ranges with steps, start/step and Sunday as 7", () => {
    expect(next("5,10-20/5 * * * *", "2030-01-01T00:10:00.000Z")).toBe("2030-01-01T00:15:00.000Z");
    expect(next("50/5 * * * *", "2030-01-01T00:56:00.000Z")).toBe("2030-01-01T01:50:00.000Z");
    expect(next("0 0 * * 7", "2030-01-01T00:00:00.000Z")).toBe("2030-01-06T00:00:00.000Z");
  });

  it("matches either day field when both are restricted", () => {
    // 2030-01-05 is a Saturday, before the 15th.
    expect(next("0 0 15 * sat", "2030-01-01T00:00:00.000Z")).toBe("2030-01-05T00:00:00.000Z");
  });

  it("rejects malformed expressions and reports dates that never occur", () => {
    for (const expression of ["* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "5-1 * * * *", "a * * * *"]) {
      expect(() => parseCronExpression(expression)).toThrow(CronExpressionError);
    }
    expect(next("0 0 30 2 *", "2030-01-01T00:00:00.000Z")).toBeUndefined();
  });
});
