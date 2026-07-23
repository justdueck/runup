/**
 * iCal-backed calendar provider.
 *
 * Reads one or more private iCal (ICS) feeds - e.g. a Google Calendar
 * "secret address in iCal format" - and turns the pilot's busy events into
 * FREE windows: expand recurring events (RRULE / EXDATE / RECURRENCE-ID
 * overrides, via node-ical), apply before/after buffers, merge overlaps,
 * then subtract the busy time from each local day's flyable hours
 * ([earliestLocalTime, latestLocalTime] in the profile time zone).
 *
 * SECRETS: the feed URL is a bearer credential. It is never logged and never
 * placed in an error message - failures are reported by feed number ("iCal
 * feed #2") and every surfaced message additionally passes through
 * {@link scrubIcalUrls}.
 *
 * Known limitations (documented rather than papered over):
 * - Google's per-event "working location" / "focus time" entries are plain
 *   VEVENTs and therefore count as busy; TRANSP:TRANSPARENT ("Free") events
 *   and STATUS:CANCELLED events are ignored.
 * - All-day events are date-based; they block whole local days (in the
 *   profile time zone) only when calendar.allDayEventsBlock is true, and the
 *   event buffers are not applied to them (the day is already fully blocked).
 * - Timed events with no DTEND/DURATION are treated as zero-length (they
 *   still block their buffers).
 */
import ical, { type CalendarResponse, type EventInstance, type VEvent } from "node-ical";
import type { Profile } from "../profile.js";
import { NodeFetcher, type HttpTextFetcher } from "../http.js";
import { addDays, compareLocalDates, formatIsoWithOffset, formatLocalHm, localDate, parseLocalTime, zonedTimeToUtc } from "../tz.js";
import type { DateRange, TimeWindow } from "../types.js";
import { round2 } from "../util.js";
import type { CalendarProvider } from "./types.js";

/** Env var carrying comma-separated private iCal feed URLs (takes precedence over the profile). */
export const ICAL_URLS_ENV = "RUNUP_ICAL_URLS";

/** A half-open [start, end) instant interval in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

/** Everything the provider needs from the profile, snapshotted per call. */
export interface IcalCalendarSettings {
  /** IANA zone the flyable hours are expressed in. */
  timeZone: string;
  /** "HH:MM" - a free window may not start before this local time. */
  earliestLocalTime: string;
  /** "HH:MM" - a free window may not end after this local time. */
  latestLocalTime: string;
  allDayEventsBlock: boolean;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** Default minimum window length (hours); overridable per query. */
  minDurationHours: number;
}

export function calendarSettingsFromProfile(profile: Profile): IcalCalendarSettings {
  return {
    timeZone: profile.preferences.timezone,
    earliestLocalTime: profile.preferences.earliestLocalTime,
    latestLocalTime: profile.preferences.latestLocalTime,
    allDayEventsBlock: profile.calendar.allDayEventsBlock,
    bufferBeforeMinutes: profile.calendar.bufferBeforeMinutes,
    bufferAfterMinutes: profile.calendar.bufferAfterMinutes,
    minDurationHours: profile.calendar.minDurationHours,
  };
}

export type IcalUrlSource = "env" | "profile" | "none";

/**
 * Where the iCal feed URLs come from: RUNUP_ICAL_URLS (comma separated)
 * wins; else profile.calendar.icalUrls. Empty entries are dropped and
 * `webcal://` is treated as `https://`.
 */
export function resolveIcalUrls(env: NodeJS.ProcessEnv, profile: Profile): { urls: string[]; source: IcalUrlSource } {
  const clean = (list: string[]): string[] =>
    list
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
      .map((u) => (u.toLowerCase().startsWith("webcal://") ? `https://${u.slice("webcal://".length)}` : u));

  const fromEnv = clean((env[ICAL_URLS_ENV] ?? "").split(","));
  if (fromEnv.length > 0) return { urls: fromEnv, source: "env" };
  const fromProfile = clean(profile.calendar.icalUrls);
  if (fromProfile.length > 0) return { urls: fromProfile, source: "profile" };
  return { urls: [], source: "none" };
}

/** Replace every occurrence of a configured feed URL in `text` (defense in depth for error paths). */
export function scrubIcalUrls(text: string, urls: string[]): string {
  let out = text;
  for (const url of urls) {
    if (url.length === 0) continue;
    out = out.split(url).join("[redacted iCal URL]");
    // Also catch the webcal:// spelling and a percent-decoded variant.
    const webcal = url.replace(/^https:\/\//i, "webcal://");
    out = out.split(webcal).join("[redacted iCal URL]");
    try {
      const decoded = decodeURIComponent(url);
      if (decoded !== url) out = out.split(decoded).join("[redacted iCal URL]");
    } catch {
      /* not decodable - nothing to scrub */
    }
  }
  return out;
}

/** Default network fetcher for feeds: timeout, calendar-friendly Accept, URL redacted from errors. */
export function defaultIcalFetcher(): HttpTextFetcher {
  return new NodeFetcher({
    headers: { Accept: "text/calendar, text/plain, */*" },
    describeUrl: () => "the configured iCal feed",
  });
}

export class IcalCalendarProvider implements CalendarProvider {
  readonly name = "ical-calendar";
  private readonly fetcher: HttpTextFetcher;

  constructor(
    private readonly urls: string[],
    private readonly settings: IcalCalendarSettings,
    fetcher?: HttpTextFetcher,
  ) {
    this.fetcher = fetcher ?? defaultIcalFetcher();
  }

  async getFreeWindows(range: DateRange, opts: { minDurationHours?: number } = {}): Promise<TimeWindow[]> {
    if (this.urls.length === 0) throw new Error("No iCal feed URLs are configured.");
    const rangeStart = new Date(range.start);
    const rangeEnd = new Date(range.end);
    if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime()) || rangeStart >= rangeEnd) {
      throw new Error("Invalid date range for the calendar query.");
    }

    const calendars = await this.fetchCalendars();
    const busy = busyIntervalsFromCalendars(calendars, { start: rangeStart, end: rangeEnd }, this.settings);
    const minDurationHours = opts.minDurationHours ?? this.settings.minDurationHours;
    return computeFreeWindows({ start: rangeStart, end: rangeEnd }, busy, this.settings, minDurationHours);
  }

  /** Fetch + parse every feed. Errors name the feed by number, never by URL. */
  private async fetchCalendars(): Promise<CalendarResponse[]> {
    return Promise.all(
      this.urls.map(async (url, index) => {
        const label = `iCal feed #${index + 1} of ${this.urls.length}`;
        let text: string;
        try {
          text = await this.fetcher.getText(url);
        } catch (err) {
          throw new Error(scrubIcalUrls(`Fetching ${label} failed: ${errorMessage(err)}`, this.urls));
        }
        try {
          return ical.sync.parseICS(text);
        } catch (err) {
          throw new Error(scrubIcalUrls(`Parsing ${label} failed: ${errorMessage(err)}`, this.urls));
        }
      }),
    );
  }
}

// --- Busy-interval extraction ---------------------------------------------------

/**
 * Collect busy intervals (already buffered and merged) from parsed
 * calendars for events overlapping `range`. Recurring events are expanded
 * within a slightly widened search window so buffers of events just
 * outside the range - and all-day events near the range edges - still count.
 */
export function busyIntervalsFromCalendars(
  calendars: CalendarResponse[],
  range: { start: Date; end: Date },
  settings: IcalCalendarSettings,
): Interval[] {
  const beforeMs = settings.bufferBeforeMinutes * 60_000;
  const afterMs = settings.bufferAfterMinutes * 60_000;
  const dayMs = 24 * 3_600_000;
  const from = new Date(range.start.getTime() - afterMs - dayMs);
  const to = new Date(range.end.getTime() + beforeMs + dayMs);

  const busy: Interval[] = [];
  for (const calendar of calendars) {
    for (const component of Object.values(calendar)) {
      if (!component || (component as { type?: string }).type !== "VEVENT") continue;
      const event = component as VEvent;
      if (event.status === "CANCELLED") continue; // deleted / cancelled event
      if (isTransparent(event)) continue; // shows as "Free" (does not block)

      let instances: EventInstance[];
      try {
        instances = ical.expandRecurringEvent(event, { from, to, expandOngoing: true });
      } catch {
        continue; // an unexpandable rule should not sink the whole query
      }
      for (const instance of instances) {
        const instanceEvent = instance.event as VEvent | undefined;
        if (instanceEvent?.status === "CANCELLED") continue; // cancelled single occurrence
        if (instance.isFullDay) {
          if (!settings.allDayEventsBlock) continue;
          busy.push(allDayInterval(instance, settings.timeZone));
        } else {
          const start = instance.start.getTime();
          const end = Math.max(start, instance.end.getTime());
          busy.push({ start: start - beforeMs, end: end + afterMs });
        }
      }
    }
  }
  return mergeIntervals(busy);
}

/** Whole local day(s) covered by a date-based (all-day) instance, in the profile zone. */
function allDayInterval(instance: EventInstance, timeZone: string): Interval {
  // node-ical hands full-day instances back as local-midnight Dates; read
  // their calendar date parts and re-anchor them in the profile zone.
  const startParts = {
    year: instance.start.getFullYear(),
    month: instance.start.getMonth() + 1,
    day: instance.start.getDate(),
  };
  let endParts = {
    year: instance.end.getFullYear(),
    month: instance.end.getMonth() + 1,
    day: instance.end.getDate(),
  };
  if (compareLocalDates(endParts, startParts) <= 0) endParts = addDays(startParts, 1); // at least one day
  return {
    start: zonedTimeToUtc(startParts, timeZone).getTime(),
    end: zonedTimeToUtc(endParts, timeZone).getTime(),
  };
}

function isTransparent(event: VEvent): boolean {
  const t = event.transparency;
  return typeof t === "string" && t.toUpperCase() === "TRANSPARENT";
}

// --- Interval math (exported for unit tests) --------------------------------------

/** Sort + merge overlapping (or touching) intervals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** `free` minus every busy interval (busy need not be pre-merged). Result is sorted. */
export function subtractIntervals(free: Interval, busy: Interval[]): Interval[] {
  let pieces: Interval[] = [{ ...free }];
  for (const b of mergeIntervals(busy)) {
    const next: Interval[] = [];
    for (const p of pieces) {
      if (b.end <= p.start || b.start >= p.end) {
        next.push(p); // no overlap
        continue;
      }
      if (b.start > p.start) next.push({ start: p.start, end: b.start });
      if (b.end < p.end) next.push({ start: b.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

/**
 * Clip the query range to each local day's flyable hours in the profile
 * zone, subtract busy intervals, drop windows shorter than
 * `minDurationHours`, and render TimeWindows (ISO timestamps carry the
 * profile-zone offset).
 */
export function computeFreeWindows(
  range: { start: Date; end: Date },
  busy: Interval[],
  settings: IcalCalendarSettings,
  minDurationHours: number,
): TimeWindow[] {
  const tz = settings.timeZone;
  const earliest = parseLocalTime(settings.earliestLocalTime);
  const latest = parseLocalTime(settings.latestLocalTime);
  const minMs = Math.max(0, minDurationHours) * 3_600_000;
  const rangeStart = range.start.getTime();
  const rangeEnd = range.end.getTime();

  const windows: TimeWindow[] = [];
  const lastDay = localDate(new Date(rangeEnd - 1), tz);
  for (let day = localDate(range.start, tz); compareLocalDates(day, lastDay) <= 0; day = addDays(day, 1)) {
    const flyStart = zonedTimeToUtc({ ...day, ...earliest }, tz).getTime();
    const flyEnd = zonedTimeToUtc({ ...day, ...latest }, tz).getTime();
    const dayWindow: Interval = { start: Math.max(rangeStart, flyStart), end: Math.min(rangeEnd, flyEnd) };
    if (dayWindow.end <= dayWindow.start) continue;
    for (const free of subtractIntervals(dayWindow, busy)) {
      if (free.end - free.start < minMs || free.end <= free.start) continue;
      windows.push(makeZonedWindow(free, tz));
    }
  }
  return windows;
}

/** TimeWindow rendered in the profile time zone (ISO with offset + a short local label). */
export function makeZonedWindow(interval: Interval, timeZone: string): TimeWindow {
  const start = new Date(interval.start);
  const end = new Date(interval.end);
  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(start);
  const tzLabel = shortZoneName(start, timeZone);
  return {
    start: formatIsoWithOffset(start, timeZone),
    end: formatIsoWithOffset(end, timeZone),
    durationHours: round2((interval.end - interval.start) / 3_600_000),
    label: `free ${dateLabel} ${formatLocalHm(start, timeZone)}-${formatLocalHm(end, timeZone)} ${tzLabel}`,
  };
}

function shortZoneName(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? ` (${cause.message})` : "";
    return `${err.message}${causeMessage}`;
  }
  return String(err);
}
