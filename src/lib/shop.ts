// The shop itself: where it is, how to reach it, and when it takes orders.
//
// SOURCE: the footer of https://portofino-essen.de/ as the operator copied it on
// 2026-09-14:
//
//   Adresse         Hauptstr. 108, 45219 Essen
//   Öffnungszeiten  Dienstag Ruhetag
//                   Mo – Fr: 12.00 – 22.30 Uhr
//                   Sa, So u. Feiertage: 13.00 – 22:30 Uhr
//                   Lieferzeit bis 22.00 Uhr
//   Telefon         02054 – 15 88 3
//
// That footer is the authority here. Two older copies disagree with it and are
// NOT used: the WPPizza widget captured into `data/menu.json` `openingHours`
// (closing at 22:00) and `audience_profile/owner-operator` (the same). The
// footer separates the shop closing (22:30) from the last delivery (22:00),
// and the widget does not — which is exactly the difference pickup exists for.
//
// Everything is computed in Europe/Berlin wall time. The server runs in UTC,
// and a diner at 21:30 in Essen must never be told the shop closed at 20:30.

/** Where and how. The phone is kept exactly as the shop prints it. */
export const SHOP = {
  name: 'Portofino Pizzeria',
  street: 'Hauptstr. 108',
  postalCode: '45219',
  city: 'Essen',
  phoneDisplay: '02054 – 15 88 3',
  /** The same number, dialable. 02054 is Essen-Kettwig's area code. */
  phoneE164: '+49205415883',
  timeZone: 'Europe/Berlin',
} as const;

/** A service window on one day, as `HH:MM` wall-clock strings. */
export interface Window {
  open: string;
  close: string;
}

export type Fulfilment = 'delivery' | 'pickup';

/** Opening hours by ISO weekday (1 = Monday … 7 = Sunday). `null` = closed. */
const WEEKLY: Record<number, Window | null> = {
  1: { open: '12:00', close: '22:30' },
  2: null, // Dienstag Ruhetag
  3: { open: '12:00', close: '22:30' },
  4: { open: '12:00', close: '22:30' },
  5: { open: '12:00', close: '22:30' },
  6: { open: '13:00', close: '22:30' },
  7: { open: '13:00', close: '22:30' },
};

/** "Sa, So u. Feiertage" — a public holiday takes the weekend hours. */
const HOLIDAY_WINDOW: Window = { open: '13:00', close: '22:30' };

/** "Lieferzeit bis 22.00 Uhr" — the last moment a delivery order is taken. */
export const DELIVERY_UNTIL = '22:00';

/**
 * The rule the footer does not settle, decided on the side that cannot leave a
 * diner waiting for food nobody cooks: a public holiday that falls on a TUESDAY
 * stays a Ruhetag. "Dienstag Ruhetag" is stated without exception, and taking
 * an order for a closed kitchen is the failure the owner cannot absorb; turning
 * a diner away on a day the shop happens to open costs one order. Owed back to
 * the owner as a question.
 */
const RUHETAG_BEATS_HOLIDAY = true;

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
  timeZone: SHOP.timeZone,
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

function toMinutes(hhmm: string): number {
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

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftDate(year: number, month: number, day: number, days: number): string {
  const t = new Date(Date.UTC(year, month - 1, day + days));
  return isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * The statutory public holidays in NRW for a year, `YYYY-MM-DD` -> name.
 * Heiligabend and Silvester are NOT public holidays and are not listed; if the
 * shop keeps special hours on them, that is not something the footer says.
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
  /** Pickup and the shop: open to close. `null` when closed all day. */
  pickup: Window | null;
  /** Delivery: open to DELIVERY_UNTIL. `null` when closed all day. */
  delivery: Window | null;
}

export function hoursOn(year: number, month: number, day: number): DayHours {
  const date = isoDate(year, month, day);
  const weekday = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
  const holiday = nrwHolidays(year).get(date);

  let window = WEEKLY[weekday] ?? null;
  if (holiday && !(RUHETAG_BEATS_HOLIDAY && weekday === 2)) window = HOLIDAY_WINDOW;

  const delivery =
    window && toMinutes(DELIVERY_UNTIL) > toMinutes(window.open)
      ? { open: window.open, close: DELIVERY_UNTIL }
      : null;

  return { date, weekday, ...(holiday ? { holiday } : {}), pickup: window, delivery };
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

function modeStatus(local: LocalDateTime, mode: Fulfilment): ModeStatus {
  const today = hoursOn(local.year, local.month, local.day);
  const window = today[mode];
  if (window && local.minutes >= toMinutes(window.open) && local.minutes < toMinutes(window.close)) {
    return { available: true, until: window.close };
  }
  // The next window that starts after now: later today, or on a following day.
  for (let offset = 0; offset <= 14; offset += 1) {
    const [y, m, d] = shiftDate(local.year, local.month, local.day, offset).split('-').map(Number) as [number, number, number];
    const day = hoursOn(y, m, d)[mode];
    if (!day) continue;
    if (offset === 0 && local.minutes >= toMinutes(day.open)) continue;
    const hours = hoursOn(y, m, d);
    return {
      available: false,
      next: { date: hours.date, weekday: WEEKDAY_DE[hours.weekday] ?? '', time: day.open },
    };
  }
  return { available: false };
}

export function shopStatus(instant: Date): ShopStatus {
  const local = berlinTime(instant);
  const minutes = String(local.minutes % 60).padStart(2, '0');
  const hours = String(Math.floor(local.minutes / 60)).padStart(2, '0');
  return {
    now: `${local.date}T${hours}:${minutes}`,
    today: hoursOn(local.year, local.month, local.day),
    pickup: modeStatus(local, 'pickup'),
    delivery: modeStatus(local, 'delivery'),
  };
}

/**
 * The German sentence a diner reads when an order of this kind is refused now,
 * or `null` when it is taken. Used verbatim by the order route.
 */
export function refusalFor(mode: Fulfilment, status: ShopStatus): string | null {
  const s = status[mode];
  if (s.available) return null;
  const when = s.next
    ? ` Wieder möglich ab ${s.next.weekday}, ${s.next.time} Uhr.`
    : '';
  if (mode === 'delivery' && status.pickup.available) {
    return `Lieferungen nehmen wir heute nur bis ${DELIVERY_UNTIL} Uhr an. Abholung ist noch bis ${status.pickup.until} Uhr möglich.${when}`;
  }
  return `Wir haben gerade geschlossen und nehmen keine Bestellungen an.${when}`;
}

/** The weekly table as the shop prints it, for display. */
export const HOURS_DISPLAY = [
  { days: 'Montag, Mittwoch – Freitag', hours: '12:00 – 22:30 Uhr' },
  { days: 'Samstag, Sonntag und Feiertage', hours: '13:00 – 22:30 Uhr' },
  { days: 'Dienstag', hours: 'Ruhetag' },
] as const;
