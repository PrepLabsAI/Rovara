// When a person may be told (lane P4, S-11 and S-12): their quiet hours and their daily digest, on their own clock. Pure functions of the time and the settings; the delivery sweep asks them.
//
//   - Inside quiet hours, what is not urgent waits; it goes in one batch on the first sweep after they end. Urgent rows (a high-risk decision, owner answer Q20) are told at once.
//   - With a digest time, what is not urgent waits for the first sweep at or after that local time each day (never inside quiet hours: then it goes when they end). One digest per local day.
import type { NotifyPrefs, QuietHours } from "./prefs.js";

const minutesOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** The local date (`YYYY-MM-DD`) and minute of the day at an instant, in a time zone (UTC when absent or unknown). */
export function localClock(nowMs: number, timeZone: string | undefined): { day: string; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  }
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "00";
  return { day: `${part("year")}-${part("month")}-${part("day")}`, minute: (Number(part("hour")) % 24) * 60 + Number(part("minute")) };
}

/**
 * The calendar day before a local `YYYY-MM-DD`, counted on the calendar itself: a day with a daylight-saving change is 23 or 25 hours long, so stepping back from the wall clock's minutes can land in the
 * same day (the fall-back night repeats an hour).
 */
export function dayBefore(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

/** Whether a minute of the day falls inside quiet hours: from the start (included) to the end (not included); a span whose end is before its start crosses midnight. */
export function inQuietHours(quiet: QuietHours | undefined, minute: number): boolean {
  if (quiet === undefined) return false;
  const start = minutesOf(quiet.start), end = minutesOf(quiet.end);
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export type Hold = "none" | "quiet" | "digest";

/**
 * Whether what is not urgent waits now, and why: `quiet` inside quiet hours; `digest` when the person has a digest time and its latest slot (today's once the time has passed, else yesterday's) was
 * already served; `none` when it may go (for a digest person that is the digest itself). A slot missed because it fell in quiet hours, or because nothing swept, is served on the first sweep after.
 * Someone who never had a digest is first served at today's slot.
 */
export function holdOf(prefs: Pick<NotifyPrefs, "quietHours" | "timeZone" | "digestAt">, nowMs: number, lastDigestDay: string | undefined): Hold {
  const { day, minute } = localClock(nowMs, prefs.timeZone);
  if (inQuietHours(prefs.quietHours, minute)) return "quiet";
  if (prefs.digestAt === undefined) return "none";
  const passedToday = minute >= minutesOf(prefs.digestAt);
  if (lastDigestDay === undefined) return passedToday ? "none" : "digest";
  const slot = passedToday ? day : dayBefore(day);
  return lastDigestDay >= slot ? "digest" : "none";
}

/** The local day a digest sent now serves (recorded so the same slot is never served twice). */
export function digestSlotDay(prefs: Pick<NotifyPrefs, "timeZone" | "digestAt">, nowMs: number): string {
  const { day, minute } = localClock(nowMs, prefs.timeZone);
  if (prefs.digestAt === undefined || minute >= minutesOf(prefs.digestAt)) return day;
  return dayBefore(day);
}
