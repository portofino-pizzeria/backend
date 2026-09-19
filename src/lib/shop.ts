// When the shop takes orders, and what a diner is told when it does not.
//
// Everything here is PURE: each function takes the restaurant's rules
// (`ShopRules`, loaded from the database by `shop-rules.ts`) as a required
// argument. The rules used to be constants in this file; they are rows the
// owner edits now, and a default argument here would quietly become a second
// source of truth the first time a closing time changed. The defaults live in
// `shop-defaults.ts` and are only ever used to seed an empty database.
//
// Everything is computed in Europe/Berlin wall time. The server runs in UTC,
// and a diner at 21:30 in Essen must never be told the shop closed at 20:30.

import type { ShopRules, SpecialDayRule } from './shop-rules.js';
import { SHOP_TIME_ZONE } from './shop-rules.js';

/** A service window on one day, as `HH:MM` wall-clock strings. */
export interface Window {
  open: string;
  close: string;
}

export type Fulfilment = 'delivery' | 'pickup';

const WEEKDAY_DE = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

// --- Berlin wall time ------------------------------------------------------

export interface LocalDateTime {
  /** `YYYY-MM-DD` in Berlin. */
  date: string;
  year: number;
  month: number;
  day: number;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
}

const berlinParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: SHOP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The Berlin calendar date and clock time of an instant. */
export function berlinTime(instant: Date): LocalDateTime {
  const parts = Object.fromEntries(
    berlinParts.formatToParts(instant).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    year,
    month,
    day,
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// --- Public holidays (Nordrhein-Westfalen) ----------------------------------

/** Easter Sunday (Gregorian), by the anonymous Gregorian algorithm. */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function shiftDate(year: number, month: number, day: number, days: number): string {
  const t = new Date(Date.UTC(year, month - 1, day + days));
  return isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * The statutory public holidays in NRW for a year, `YYYY-MM-DD` -> name.
 * Heiligabend and Silvester are NOT public holidays and are not listed; the
 * shop's hours on those two days are special-day rows instead (decision D4).
 */
export function nrwHolidays(year: number): Map<string, string> {
  const easter = easterSunday(year);
  const fromEaster = (offset: number) => shiftDate(year, easter.month, easter.day, offset);
  return new Map([
    [isoDate(year, 1, 1), 'Neujahr'],
    [fromEaster(-2), 'Karfreitag'],
    [fromEaster(1), 'Ostermontag'],
    [isoDate(year, 5, 1), 'Tag der Arbeit'],
    [fromEaster(39), 'Christi Himmelfahrt'],
    [fromEaster(50), 'Pfingstmontag'],
    [fromEaster(60), 'Fronleichnam'],
    [isoDate(year, 10, 3), 'Tag der Deutschen Einheit'],
    [isoDate(year, 11, 1), 'Allerheiligen'],
    [isoDate(year, 12, 25), '1. Weihnachtstag'],
    [isoDate(year, 12, 26), '2. Weihnachtstag'],
  ]);
}

// --- The day's windows -----------------------------------------------------

export interface DayHours {
  date: string;
  weekday: number;
  /** Set when the day is a public holiday. */
  holiday?: string;
  /**
   * The sentence a diner reads when a special day decided this date: the
   * owner's own LABEL ("Silvester", "Betriebsurlaub") with the hours this
   * server enforces appended. The owner writes the label and edits the times;
   * the sentence is composed here, so a changed closing time can never leave a
   * stale "geöffnet bis 18:00 Uhr" in front of a door that shuts at 17:00
   * (decision D3: the owner edits times, never sentences).
   */
  special?: string;
  /** Pickup and the shop: open to close. `null` when closed all day. */
  pickup: Window | null;
  /** Delivery: open to the day's delivery close. `null` when no delivery. */
  delivery: Window | null;
}

/** The `MM-DD` key a recurring special day is matched by. */
function monthDayOf(month: number, day: number): string {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The hours of one calendar date, in this order of precedence:
 *
 *   1. a DATED special day — the owner typed this exact date, so it wins
 *      outright, Ruhetag included;
 *   2. a RECURRING special day (Heiligabend, Silvester);
 *   3. a public holiday, which takes the holiday window;
 *   4. the weekday's own row.
 *
 * "Ruhetag" means a weekday whose weekly row is closed — not Tuesday. While
 * `ruhetagBeatsHoliday` is set, neither a public holiday nor a recurring
 * special day opens a Ruhetag; only a dated row, which names that one date,
 * can. One setting governs both, for the reason decision D1 gives for
 * holidays: nobody may be told to collect food from a kitchen with no cook in
 * it.
 */
export function hoursOn(
  rules: ShopRules,
  year: number,
  month: number,
  day: number,
): DayHours {
  const date = isoDate(year, month, day);
  const weekday = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
  const holiday = nrwHolidays(year).get(date);

  const weeklyWindow = rules.weekly[weekday] ?? null;
  const isRuhetag = weeklyWindow === null;
  const ruhetagWins = rules.ruhetagBeatsHoliday && isRuhetag;

  const dated = rules.specialDays.find((s) => s.date === date);
  const recurring = rules.specialDays.find((s) => s.monthDay === monthDayOf(month, day));
  const special = dated ?? (ruhetagWins ? undefined : recurring);

  let window: Window | null = weeklyWindow;
  let deliveryUntil = rules.deliveryUntil;
  let note: string | undefined;

  if (special) {
    note = special.note || undefined;
    window = resolveSpecialWindow(special, weeklyWindow);
    if (special.deliveryUntil) deliveryUntil = special.deliveryUntil;
  } else if (holiday && !ruhetagWins) {
    window = rules.holiday;
  }

  // A window that closes at or before it opens is not a short day, it is a
  // closed one — and saying "12:00 – 12:00 Uhr" to a diner would be worse than
  // saying "geschlossen".
  if (window && toMinutes(window.close) <= toMinutes(window.open)) window = null;

  // The delivery cut-off never outlives the shop's own closing time: the
  // kitchen is empty after it, whatever the profile-wide value says.
  const delivery = deliveryWindow(window, deliveryUntil);

  return {
    date,
    weekday,
    ...(holiday ? { holiday } : {}),
    ...(note ? { special: specialSentence(note, window, delivery) } : {}),
    pickup: window,
    delivery,
  };
}

/**
 * The diner-facing sentence for a special day: the owner's label plus the
 * hours actually enforced for that date. Composed, never stored — a stored
 * sentence is a second source of truth, and the first edit of a closing time
 * would make it a lie (decision D3).
 */
export function specialSentence(
  label: string,
  window: Window | null,
  delivery: Window | null,
): string {
  if (!window) return `${label}: geschlossen`;
  const base = `${label}: geöffnet bis ${window.close} Uhr`;
  if (!delivery) return `${base}, keine Lieferung`;
  if (delivery.close === window.close) return base;
  return `${base}, Lieferung bis ${delivery.close} Uhr`;
}

/**
 * The window a special day resolves to. `open === null` means "the weekday's
 * normal opening" (D4) — and when that weekday is closed there is no opening
 * to inherit, so the day stays closed.
 */
function resolveSpecialWindow(
  special: SpecialDayRule,
  weeklyWindow: Window | null,
): Window | null {
  if (special.closed || !special.close) return null;
  const open = special.open ?? weeklyWindow?.open ?? null;
  if (!open) return null;
  return { open, close: special.close };
}

function deliveryWindow(window: Window | null, deliveryUntil: string): Window | null {
  if (!window) return null;
  const close =
    toMinutes(deliveryUntil) < toMinutes(window.close) ? deliveryUntil : window.close;
  // A cut-off at or before the opening means there is no delivery that day —
  // a state the editor allows on purpose ("Abholung only" on a short day).
  return toMinutes(close) > toMinutes(window.open) ? { open: window.open, close } : null;
}

// --- Status now -------------------------------------------------------------

export interface ModeStatus {
  /** Whether an order of this kind is taken right now. */
  available: boolean;
  /** While available: the local `HH:MM` it stops being taken today. */
  until?: string;
  /** While not available: when it is next taken. */
  next?: { date: string; weekday: string; time: string };
}

export interface ShopStatus {
  /** The Berlin date and time the status was computed for. */
  now: string;
  today: DayHours;
  pickup: ModeStatus;
  delivery: ModeStatus;
}

function modeStatus(rules: ShopRules, local: LocalDateTime, mode: Fulfilment): ModeStatus {
  const today = hoursOn(rules, local.year, local.month, local.day);
  const window = today[mode];
  if (window && local.minutes >= toMinutes(window.open) && local.minutes < toMinutes(window.close)) {
    return { available: true, until: window.close };
  }
  // The next window that starts after now: later today, or on a following day.
  for (let offset = 0; offset <= 14; offset += 1) {
    const [y, m, d] = shiftDate(local.year, local.month, local.day, offset).split('-').map(Number) as [number, number, number];
    const hours = hoursOn(rules, y, m, d);
    const day = hours[mode];
    if (!day) continue;
    if (offset === 0 && local.minutes >= toMinutes(day.open)) continue;
    return {
      available: false,
      next: { date: hours.date, weekday: WEEKDAY_DE[hours.weekday] ?? '', time: day.open },
    };
  }
  return { available: false };
}

export function shopStatus(rules: ShopRules, instant: Date): ShopStatus {
  const local = berlinTime(instant);
  const minutes = String(local.minutes % 60).padStart(2, '0');
  const hours = String(Math.floor(local.minutes / 60)).padStart(2, '0');
  return {
    now: `${local.date}T${hours}:${minutes}`,
    today: hoursOn(rules, local.year, local.month, local.day),
    pickup: modeStatus(rules, local, 'pickup'),
    delivery: modeStatus(rules, local, 'delivery'),
  };
}

/**
 * The German sentence a diner reads when an order of this kind is refused now,
 * or `null` when it is taken. Used verbatim by the order route.
 *
 * The delivery sentence names THIS DAY's delivery close, read off the status,
 * not a shop-wide constant — on Heiligabend the last delivery is 13:30, and a
 * sentence that said 22:00 there would be a lie the diner acts on.
 */
export function refusalFor(mode: Fulfilment, status: ShopStatus): string | null {
  const s = status[mode];
  if (s.available) return null;
  const when = s.next
    ? ` Wieder möglich ab ${s.next.weekday}, ${s.next.time} Uhr.`
    : '';
  if (mode === 'delivery' && status.pickup.available) {
    const until = status.today.delivery?.close;
    if (until) {
      return `Lieferungen nehmen wir heute nur bis ${until} Uhr an. Abholung ist noch bis ${status.pickup.until} Uhr möglich.${when}`;
    }
    // The shop is open but delivers nothing today at all.
    return `Wir liefern heute nicht. Abholung ist noch bis ${status.pickup.until} Uhr möglich.${when}`;
  }
  return `Wir haben gerade geschlossen und nehmen keine Bestellungen an.${when}`;
}

// --- The printed hours ------------------------------------------------------

export interface DisplayRow {
  days: string;
  hours: string;
}

/**
 * The weekly table as the shop prints it — derived from the SAME rows the
 * server enforces, so the printed hours cannot drift from the real ones. It
 * used to be a hand-written constant sitting beside the weekly table
 * (decision D3).
 *
 * Grouping: weekdays with an identical window share a row; a run of three or
 * more consecutive weekdays is written as a range ("Mittwoch – Freitag"),
 * anything shorter is listed ("Samstag, Sonntag"). The public-holiday window
 * is merged into the group with the same window as " und Feiertage", which is
 * what the site's own footer prints; only when no group matches does it get a
 * row of its own. Ruhetage come last.
 */
export function displayHours(rules: ShopRules): DisplayRow[] {
  const groups = new Map<string, number[]>();
  const ruhetage: number[] = [];

  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const window = rules.weekly[weekday] ?? null;
    if (!window) {
      ruhetage.push(weekday);
      continue;
    }
    const key = `${window.open}-${window.close}`;
    groups.set(key, [...(groups.get(key) ?? []), weekday]);
  }

  const holidayKey = `${rules.holiday.open}-${rules.holiday.close}`;
  const rows: DisplayRow[] = [];
  for (const [key, weekdays] of groups) {
    const [open, close] = key.split('-') as [string, string];
    const days =
      key === holidayKey
        ? `${weekdayLabel(weekdays)} und Feiertage`
        : weekdayLabel(weekdays);
    rows.push({ days, hours: `${open} – ${close} Uhr` });
  }

  // A holiday window that matches no weekday group is still a real window a
  // diner can turn up in, so it gets its own line rather than going unprinted.
  if (!groups.has(holidayKey)) {
    rows.push({
      days: 'Feiertage',
      hours: `${rules.holiday.open} – ${rules.holiday.close} Uhr`,
    });
  }

  if (ruhetage.length > 0) {
    rows.push({ days: weekdayLabel(ruhetage), hours: 'Ruhetag' });
  }

  return rows;
}

/** "Montag, Mittwoch – Freitag" for [1, 3, 4, 5]. */
function weekdayLabel(weekdays: number[]): string {
  const sorted = [...weekdays].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const weekday of sorted) {
    const run = runs[runs.length - 1];
    if (run && weekday === (run[run.length - 1] ?? 0) + 1) run.push(weekday);
    else runs.push([weekday]);
  }

  const parts: string[] = [];
  for (const run of runs) {
    const first = run[0] as number;
    const last = run[run.length - 1] as number;
    // Two days read better listed ("Samstag, Sonntag") than as a range; three
    // or more read better as a range, which is how the footer prints them.
    if (run.length >= 3) parts.push(`${WEEKDAY_DE[first]} – ${WEEKDAY_DE[last]}`);
    else parts.push(...run.map((weekday) => WEEKDAY_DE[weekday] ?? ''));
  }
  return parts.join(', ');
}

// --- Special days a diner should know about ---------------------------------

/**
 * Every date in the next `days` days (today included) whose hours were decided
 * by a special day, in date order — so the menu can say "Silvester: geöffnet
 * bis 18:00 Uhr" before the diner stands in front of a closed door. `special`
 * is always set on these.
 */
export function upcomingSpecialDays(
  rules: ShopRules,
  instant: Date,
  days = 30,
): DayHours[] {
  const local = berlinTime(instant);
  const found: DayHours[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const [y, m, d] = shiftDate(local.year, local.month, local.day, offset)
      .split('-')
      .map(Number) as [number, number, number];
    const hours = hoursOn(rules, y, m, d);
    if (hours.special) found.push(hours);
  }
  return found;
}
