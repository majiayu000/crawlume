// Five-field cron expressions (minute hour day-of-month month day-of-week), evaluated in UTC.

export class CronExpressionError extends Error {
  readonly code = "CRON_EXPRESSION_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "CronExpressionError";
  }
}

export type CronSchedule = Readonly<{
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}>;

const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const weekdayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const minuteMs = 60_000;
// Five years covers every leap-day schedule; an expression with no match in that window never fires.
const searchHorizonMs = 5 * 366 * 24 * 60 * minuteMs;

function fieldValue(token: string, minimum: number, names: readonly string[] | null): number {
  const named = names?.indexOf(token.toLowerCase()) ?? -1;
  if (named >= 0) return named + minimum;
  if (!/^[0-9]{1,2}$/u.test(token)) throw new CronExpressionError(`Cron value ${token} is invalid.`);
  return Number(token);
}

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  names: readonly string[] | null = null,
): Set<number> {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (range === undefined || range === "" || extra !== undefined) {
      throw new CronExpressionError(`Cron field ${source} is invalid.`);
    }
    const step = stepText === undefined ? 1 : fieldValue(stepText, 0, null);
    if (step < 1) throw new CronExpressionError(`Cron step in ${source} must be positive.`);
    let start = minimum;
    let end = maximum;
    if (range !== "*") {
      const [first, last, rest] = range.split("-");
      if (first === undefined || rest !== undefined) {
        throw new CronExpressionError(`Cron field ${source} is invalid.`);
      }
      start = fieldValue(first, minimum, names);
      end = last === undefined ? (stepText === undefined ? start : maximum) : fieldValue(last, minimum, names);
    }
    if (start < minimum || end > maximum || start > end) {
      throw new CronExpressionError(`Cron field ${source} is out of range ${minimum}-${maximum}.`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new CronExpressionError("A cron expression must have five fields: minute hour day month weekday.");
  }
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  // Day-of-week accepts 7 as Sunday.
  const weekdays = parseField(weekday, 0, 7, weekdayNames);
  if (weekdays.delete(7)) weekdays.add(0);
  return Object.freeze({
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    days: parseField(day, 1, 31),
    months: parseField(month, 1, 12, monthNames),
    weekdays,
    daysRestricted: day !== "*",
    weekdaysRestricted: weekday !== "*",
  });
}

function dayMatches(schedule: CronSchedule, time: Date): boolean {
  const day = schedule.days.has(time.getUTCDate());
  const weekday = schedule.weekdays.has(time.getUTCDay());
  // Standard cron: when both day fields are restricted, either one matching is enough.
  if (schedule.daysRestricted && schedule.weekdaysRestricted) return day || weekday;
  return day && weekday;
}

/** Returns the first matching minute strictly after `after`, or null when none exists within five years. */
export function nextCronTime(schedule: CronSchedule, after: Date): Date | null {
  const limit = after.getTime() + searchHorizonMs;
  const time = new Date(Math.floor(after.getTime() / minuteMs) * minuteMs + minuteMs);
  while (time.getTime() <= limit) {
    if (!schedule.months.has(time.getUTCMonth() + 1)) {
      time.setUTCMonth(time.getUTCMonth() + 1, 1);
      time.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(schedule, time)) {
      time.setUTCDate(time.getUTCDate() + 1);
      time.setUTCHours(0, 0, 0, 0);
    } else if (!schedule.hours.has(time.getUTCHours())) {
      time.setUTCHours(time.getUTCHours() + 1, 0, 0, 0);
    } else if (!schedule.minutes.has(time.getUTCMinutes())) {
      time.setTime(time.getTime() + minuteMs);
    } else {
      return time;
    }
  }
  return null;
}
