// The owner's restaurant editor — the write half of `/api/admin/shop/*`.
//
// The sibling of `menu-admin-service.ts`, and a safety surface for the same
// reason: what it stores is what the server ENFORCES. A wrong closing time
// here does not merely look wrong, it takes orders for a kitchen nobody is
// standing in, or refuses orders the shop wanted. Five properties are
// load-bearing and each one is enforced in this file (decision D5):
//
//  1. EACH PART IS SAVED WHOLE. All 7 weekdays in one request, all the profile
//     fields in one request, a whole holiday in one request. No write can
//     leave the week half-updated, and none of them writes twice.
//  2. IMPOSSIBLE STATES ARE REFUSED. A time that is not HH:MM, a window that
//     closes before it opens, a delivery cut-off after closing, a dated day in
//     the past, a special day that is both recurring and dated (or neither),
//     two rows for the same day — including two rows inside one batch.
//  3. CLOSING THE WHOLE WEEK NEEDS A CONFIRMATION, the same shape as
//     `confirmNoAllergens` on the menu side: the difference between "Ruhetag
//     on Tuesday" and "shut forever" must not be one mis-tap.
//  4. TWO PHONES CANNOT OVERWRITE EACH OTHER. Every write carries the
//     `version` it was read at and is refused with 409 if the shop moved on.
//  5. EVERY WRITE IS UNDOABLE. One transaction, plus an `admin_changes` row
//     holding whole-shop snapshots — so one undo reverses any kind of write,
//     and the undo is itself a change, which makes a second undo a redo.

import { and, desc, eq, ne, sql as drizzleSql } from 'drizzle-orm';

import { db } from '../db/client.js';
import {
  adminChanges,
  shopProfile,
  shopSpecialDays,
  shopWeeklyHours,
  type ShopProfileRow,
  type ShopSpecialDayRow,
  type ShopWeeklyHoursRow,
} from '../db/schema.js';
import { now } from './clock.js';
import { badRequest, conflict, notFound, serviceUnavailable } from './http-errors.js';
import { noteLegalFacts } from './legal-status.js';
import { rulesFromRows, type ShopRules, type SpecialDayRule } from './shop-rules.js';
import {
  berlinTime,
  displayHours,
  hoursOn,
  shiftDate,
  shopStatus,
  toMinutes,
  type DayHours,
  type DisplayRow,
  type ShopStatus,
} from './shop.js';

/** The transaction handle drizzle passes to a `db.transaction` callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// --- The shapes the editor reads and writes ---------------------------------

export interface AdminProfile {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  phoneDisplay: string;
  /** Derived on the server from `phoneDisplay`; the client never sends it. */
  phoneE164: string;
  deliveryUntil: string;
  holidayOpen: string;
  holidayClose: string;
  ruhetagBeatsHoliday: boolean;
}

export interface AdminLegal {
  legalOwnerName: string | null;
  legalForm: string | null;
  email: string | null;
  vatId: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
  /** ISO timestamp of the last confirmed save. */
  confirmedAt: string | null;
}

export interface AdminWeekday {
  weekday: number;
  /** Both `null` = Ruhetag. */
  open: string | null;
  close: string | null;
}

export interface AdminSpecialDay {
  id: number;
  /** Exactly one of `date` / `monthDay` is set. */
  date: string | null;
  monthDay: string | null;
  closed: boolean;
  /** `null` on a recurring row = the weekday's normal opening. */
  open: string | null;
  close: string | null;
  deliveryUntil: string | null;
  note: string;
  /** `false` = "Vorbelegt – bitte prüfen". */
  confirmed: boolean;
}

export interface AdminShop {
  version: number;
  /** An `admin_changes` row exists to undo. */
  canUndo: boolean;
  profile: AdminProfile;
  legal: AdminLegal;
  weekly: AdminWeekday[];
  /** Dated rows in the past are included; the editor may hide them. */
  specialDays: AdminSpecialDay[];
}

// --- Inputs -----------------------------------------------------------------

export interface ProfileInput {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  phoneDisplay: string;
  version: number;
}

export interface HoursInput {
  weekly: AdminWeekday[];
  deliveryUntil: string;
  holidayOpen: string;
  holidayClose: string;
  ruhetagBeatsHoliday: boolean;
  confirmAllClosed?: boolean;
  version: number;
}

export interface SpecialDayInput {
  date?: string | null;
  monthDay?: string | null;
  closed: boolean;
  open?: string | null;
  close?: string | null;
  deliveryUntil?: string | null;
  note?: string;
}

export interface LegalInput {
  legalOwnerName?: string | null;
  legalForm?: string | null;
  email?: string | null;
  vatId?: string | null;
  registerCourt?: string | null;
  registerNumber?: string | null;
  confirmed: boolean;
  version: number;
}

export interface PreviewDraft {
  weekly?: AdminWeekday[];
  deliveryUntil?: string;
  holidayOpen?: string;
  holidayClose?: string;
  ruhetagBeatsHoliday?: boolean;
  /** When given, REPLACES the stored list. Rows need no id. */
  specialDays?: SpecialDayInput[];
}

export interface ShopPreview {
  display: DisplayRow[];
  status: ShopStatus;
  /** Today and the next seven days. */
  days: DayHours[];
}

// --- Validation -------------------------------------------------------------

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAY = /^\d{2}-\d{2}$/;

const WEEKDAY_DE = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

/** The exact sentence the editor shows on a lost race. Contract, not prose. */
export const STALE_VERSION_MESSAGE =
  'Inzwischen hat jemand anderes gespeichert – bitte neu laden.';

function assertTime(value: string, what: string): void {
  if (!TIME.test(value)) {
    throw badRequest(`${what} muss eine Uhrzeit im Format HH:MM sein (z. B. 12:00), nicht „${value}“.`);
  }
}

function assertWindow(open: string, close: string, what: string): void {
  assertTime(open, `${what}: die Öffnungszeit`);
  assertTime(close, `${what}: die Schließzeit`);
  if (toMinutes(close) <= toMinutes(open)) {
    throw badRequest(
      `${what}: die Schließzeit (${close}) muss nach der Öffnungszeit (${open}) liegen. ` +
        'Über Mitternacht hinaus können wir nicht speichern.',
    );
  }
}

/** A real day in the calendar, not just four digits and two dashes. */
function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() + 1 === m && probe.getUTCDate() === d
  );
}

/** `MM-DD`, validated against a leap year so 02-29 is allowed. */
function isRealMonthDay(value: string): boolean {
  return MONTH_DAY.test(value) && isRealDate(`2024-${value}`);
}

/** The label a refusal uses for one row, so the owner knows which day broke. */
function dayLabel(day: SpecialDayInput): string {
  return day.date ?? day.monthDay ?? 'Der Sondertag';
}

/**
 * Everything about ONE special day that does not depend on the calendar:
 * exactly one of date/monthDay, a closing time when it is open, real times,
 * and a delivery cut-off that does not outlive the closing time.
 *
 * Deliberately separate from the "not in the past" rule below: undo replays a
 * stored snapshot and must not fail merely because midnight has passed since
 * the day was entered.
 */
function assertSpecialDayShape(day: SpecialDayInput): void {
  const hasDate = Boolean(day.date);
  const hasMonthDay = Boolean(day.monthDay);
  if (hasDate === hasMonthDay) {
    throw badRequest(
      'Ein Sondertag braucht entweder ein Datum (einmalig) oder einen Tag im Jahr ' +
        '(jährlich) – genau eines von beiden.',
    );
  }
  if (hasDate && !isRealDate(day.date as string)) {
    throw badRequest(`„${day.date}“ ist kein gültiges Datum (erwartet: JJJJ-MM-TT).`);
  }
  if (hasMonthDay && !isRealMonthDay(day.monthDay as string)) {
    throw badRequest(`„${day.monthDay}“ ist kein gültiger Tag im Jahr (erwartet: MM-TT).`);
  }

  if (day.closed) return;

  if (!day.close) {
    throw badRequest(
      `${dayLabel(day)}: an einem geöffneten Tag brauchen wir eine Schließzeit.`,
    );
  }
  if (!day.open && hasDate) {
    // "Open as usual" only means something where a weekday to inherit from
    // recurs; a one-off date names its own opening time.
    throw badRequest(`${dayLabel(day)}: an einem geöffneten Tag brauchen wir eine Öffnungszeit.`);
  }
  if (day.open) assertWindow(day.open, day.close, dayLabel(day));
  else assertTime(day.close, `${dayLabel(day)}: die Schließzeit`);

  if (day.deliveryUntil) {
    assertTime(day.deliveryUntil, `${dayLabel(day)}: „Lieferung bis“`);
    // Earlier than the opening is allowed and means "no delivery that day" —
    // after the closing time is simply impossible.
    if (toMinutes(day.deliveryUntil) > toMinutes(day.close)) {
      throw badRequest(
        `${dayLabel(day)}: „Lieferung bis“ (${day.deliveryUntil}) kann nicht nach der ` +
          `Schließzeit (${day.close}) liegen.`,
      );
    }
  }
}

/** Refuse a one-off date that has already passed. New entries only. */
function assertNotInThePast(day: SpecialDayInput): void {
  if (!day.date) return;
  const today = berlinTime(now()).date;
  if (day.date < today) {
    throw badRequest(
      `Der ${day.date} liegt in der Vergangenheit – für vergangene Tage können wir ` +
        'nichts mehr eintragen.',
    );
  }
}

/** No two rows for the same date, or the same day of the year. */
function assertNoDuplicates(days: { date: string | null; monthDay: string | null }[]): void {
  const seen = new Set<string>();
  for (const day of days) {
    const key = day.date ? `d:${day.date}` : `m:${day.monthDay}`;
    if (seen.has(key)) {
      throw badRequest(
        day.date
          ? `Für den ${day.date} gibt es schon einen Eintrag. Bitte den vorhandenen ändern.`
          : `Für den ${day.monthDay} gibt es schon einen jährlichen Eintrag. Bitte den vorhandenen ändern.`,
      );
    }
    seen.add(key);
  }
}

/**
 * The invariants a STORED shop must satisfy, whatever wrote it. Undo runs this
 * over the snapshot it is about to restore: the structural rules hold there
 * too, only the calendar-dependent one does not.
 */
function assertSnapshotIsSound(snapshot: ShopSnapshot): void {
  assertTime(snapshot.profile.deliveryUntil, '„Lieferung bis“');
  assertWindow(snapshot.profile.holidayOpen, snapshot.profile.holidayClose, 'Feiertage');
  for (const day of snapshot.weekly) {
    if (day.open === null && day.close === null) continue;
    if (day.open === null || day.close === null) {
      throw badRequest(
        `${WEEKDAY_DE[day.weekday] ?? day.weekday}: bitte Öffnungs- UND Schließzeit angeben, ` +
          'oder den Tag als Ruhetag speichern.',
      );
    }
    assertWindow(day.open, day.close, WEEKDAY_DE[day.weekday] ?? `Wochentag ${day.weekday}`);
  }
  for (const day of snapshot.specialDays) assertSpecialDayShape(day);
  assertNoDuplicates(snapshot.specialDays);
}

/**
 * `phone_e164` is DERIVED here, never sent by the client: a wrong number is a
 * silent, total failure of tap-to-call (`domain_spec/menu`), and the display
 * string the owner types is the only thing they can check by eye.
 *
 * Strips the separators a German number is printed with, turns a leading `0`
 * or `0049` into `+49`, and requires 6–13 digits after it with no leading
 * zero. `02054 – 15 88 3` becomes `+49205415883`.
 */
export function toE164(phoneDisplay: string): string | null {
  const cleaned = phoneDisplay.replace(/[\s\-–—/().]/g, '');
  let rest: string;
  if (cleaned.startsWith('+49')) rest = cleaned.slice(3);
  else if (cleaned.startsWith('0049')) rest = cleaned.slice(4);
  else if (cleaned.startsWith('49') && cleaned.length > 10) rest = cleaned.slice(2);
  else if (cleaned.startsWith('0')) rest = cleaned.slice(1);
  else return null;

  // No leading zero (that would be a second trunk prefix), digits only, and a
  // length a German subscriber number actually has.
  if (!/^[1-9]\d{5,12}$/.test(rest)) return null;
  return `+49${rest}`;
}

function requireE164(phoneDisplay: string): string {
  const e164 = toE164(phoneDisplay);
  if (!e164) {
    throw badRequest(
      `„${phoneDisplay}“ ist keine gültige deutsche Telefonnummer. Bitte mit Vorwahl ` +
        'angeben, z. B. 02054 – 15 88 3.',
    );
  }
  return e164;
}

/** A light shape check — the Impressum must not carry an unreachable address. */
function normaliseEmail(value: string | null | undefined): string | null {
  const email = value?.trim() ?? '';
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw badRequest(`„${email}“ sieht nicht wie eine E-Mail-Adresse aus.`);
  }
  return email;
}

function trimOrNull(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text.length > 0 ? text : null;
}

// --- Reading ----------------------------------------------------------------

/**
 * The whole shop as one JSON value, for `admin_changes.before` / `.after`.
 * A snapshot rather than a diff: one undo then reverses any kind of write,
 * with no per-entity replay logic that could be wrong for exactly the write
 * the owner wants back.
 */
interface ShopSnapshot {
  profile: {
    name: string;
    street: string;
    postalCode: string;
    city: string;
    phoneDisplay: string;
    phoneE164: string;
    email: string | null;
    deliveryUntil: string;
    holidayOpen: string;
    holidayClose: string;
    ruhetagBeatsHoliday: boolean;
    legalOwnerName: string | null;
    legalForm: string | null;
    vatId: string | null;
    registerCourt: string | null;
    registerNumber: string | null;
    legalConfirmedAt: string | null;
  };
  weekly: AdminWeekday[];
  specialDays: (AdminSpecialDay & { id: number })[];
}

const MISSING_SHOP =
  'Die Restaurantdaten sind auf diesem Server noch nicht angelegt. Bitte den ' +
  'Server neu starten oder die Einrichtung ausführen.';

async function lockedProfile(tx: Tx): Promise<ShopProfileRow> {
  // `for update` serialises the editor's writers for the length of the
  // transaction, so the version check below cannot be won by two requests.
  const [profile] = await tx
    .select()
    .from(shopProfile)
    .where(eq(shopProfile.id, 1))
    .for('update');
  if (!profile) throw serviceUnavailable(MISSING_SHOP);
  return profile;
}

async function readRows(
  tx: Tx | typeof db,
): Promise<{
  profile: ShopProfileRow | undefined;
  weekly: ShopWeeklyHoursRow[];
  specialDays: ShopSpecialDayRow[];
}> {
  const [profiles, weekly, specialDays] = await Promise.all([
    tx.select().from(shopProfile).where(eq(shopProfile.id, 1)),
    tx.select().from(shopWeeklyHours).orderBy(shopWeeklyHours.weekday),
    tx.select().from(shopSpecialDays).orderBy(shopSpecialDays.id),
  ]);
  return { profile: profiles[0], weekly, specialDays };
}

function toAdminShop(
  profile: ShopProfileRow,
  weekly: ShopWeeklyHoursRow[],
  specialDays: ShopSpecialDayRow[],
  canUndo: boolean,
): AdminShop {
  return {
    version: profile.version,
    canUndo,
    profile: {
      name: profile.name,
      street: profile.street,
      postalCode: profile.postalCode,
      city: profile.city,
      phoneDisplay: profile.phoneDisplay,
      phoneE164: profile.phoneE164,
      deliveryUntil: profile.deliveryUntil,
      holidayOpen: profile.holidayOpen,
      holidayClose: profile.holidayClose,
      ruhetagBeatsHoliday: profile.ruhetagBeatsHoliday,
    },
    legal: {
      legalOwnerName: profile.legalOwnerName,
      legalForm: profile.legalForm,
      email: profile.email,
      vatId: profile.vatId,
      registerCourt: profile.registerCourt,
      registerNumber: profile.registerNumber,
      confirmedAt: profile.legalConfirmedAt
        ? profile.legalConfirmedAt.toISOString()
        : null,
    },
    weekly: weekly.map((row) => ({
      weekday: row.weekday,
      open: row.open,
      close: row.close,
    })),
    specialDays: specialDays.map((row) => ({
      id: row.id,
      date: row.date,
      monthDay: row.monthDay,
      closed: row.closed,
      open: row.open,
      close: row.close,
      deliveryUntil: row.deliveryUntil,
      note: row.note,
      confirmed: row.confirmed,
    })),
  };
}

async function hasHistory(tx: Tx | typeof db): Promise<boolean> {
  const [row] = await tx
    .select({ id: adminChanges.id })
    .from(adminChanges)
    .where(eq(adminChanges.entity, SHOP_ENTITY))
    .orderBy(desc(adminChanges.id))
    .limit(1);
  return Boolean(row);
}

/** `GET /api/admin/shop`. */
export async function loadAdminShop(): Promise<AdminShop> {
  const { profile, weekly, specialDays } = await readRows(db);
  if (!profile) throw serviceUnavailable(MISSING_SHOP);
  return toAdminShop(profile, weekly, specialDays, await hasHistory(db));
}

async function snapshot(tx: Tx): Promise<ShopSnapshot> {
  const { profile, weekly, specialDays } = await readRows(tx);
  if (!profile) throw serviceUnavailable(MISSING_SHOP);
  const shop = toAdminShop(profile, weekly, specialDays, false);
  return {
    profile: {
      ...shop.profile,
      email: profile.email,
      legalOwnerName: profile.legalOwnerName,
      legalForm: profile.legalForm,
      vatId: profile.vatId,
      registerCourt: profile.registerCourt,
      registerNumber: profile.registerNumber,
      legalConfirmedAt: shop.legal.confirmedAt,
    },
    weekly: shop.weekly,
    specialDays: shop.specialDays,
  };
}

// --- Writing ----------------------------------------------------------------

const SHOP_ENTITY = 'shop';

/**
 * Every write goes through here: lock, check the version, take a `before`
 * snapshot, mutate, validate the result, bump the version, record the change,
 * and return the whole shop — all in ONE transaction, so an interrupted save
 * leaves the previous good version live.
 */
async function writeShop(
  version: number,
  mutate: (tx: Tx, before: ShopSnapshot) => Promise<void>,
): Promise<AdminShop> {
  const result = await db.transaction(async (tx) => {
    const profile = await lockedProfile(tx);
    if (profile.version !== version) throw conflict(STALE_VERSION_MESSAGE);

    const before = await snapshot(tx);
    await mutate(tx, before);
    const after = await snapshot(tx);
    assertSnapshotIsSound(after);

    await tx
      .update(shopProfile)
      .set({ version: profile.version + 1, updatedAt: new Date() })
      .where(eq(shopProfile.id, 1));
    await tx
      .insert(adminChanges)
      .values({ entity: SHOP_ENTITY, before, after });

    const { profile: saved, weekly, specialDays } = await readRows(tx);
    if (!saved) throw serviceUnavailable(MISSING_SHOP);
    return toAdminShop(saved, weekly, specialDays, true);
  });

  // The /api/health legal cache follows every write made by this process, so
  // a deploy's warning is current without the health route ever querying.
  noteLegalFacts({
    legalOwnerName: result.legal.legalOwnerName,
    legalForm: result.legal.legalForm,
    email: result.legal.email,
    vatId: result.legal.vatId,
    registerCourt: result.legal.registerCourt,
    registerNumber: result.legal.registerNumber,
    confirmedAt: result.legal.confirmedAt,
  });
  return result;
}

/** `PUT /api/admin/shop/profile` — address and phone. Never the email. */
export async function saveProfile(input: ProfileInput): Promise<AdminShop> {
  const name = input.name.trim();
  const street = input.street.trim();
  const postalCode = input.postalCode.trim();
  const city = input.city.trim();
  const phoneDisplay = input.phoneDisplay.trim();
  for (const [value, what] of [
    [name, 'Der Name des Restaurants'],
    [street, 'Die Straße'],
    [postalCode, 'Die Postleitzahl'],
    [city, 'Der Ort'],
    [phoneDisplay, 'Die Telefonnummer'],
  ] as const) {
    if (!value) throw badRequest(`${what} darf nicht leer sein.`);
  }
  const phoneE164 = requireE164(phoneDisplay);

  return writeShop(input.version, async (tx) => {
    await tx
      .update(shopProfile)
      .set({ name, street, postalCode, city, phoneDisplay, phoneE164 })
      .where(eq(shopProfile.id, 1));
  });
}

/** `PUT /api/admin/shop/hours` — all seven weekdays and the shop-wide times. */
export async function saveHours(input: HoursInput): Promise<AdminShop> {
  const byWeekday = new Map<number, AdminWeekday>();
  for (const day of input.weekly) {
    if (!Number.isInteger(day.weekday) || day.weekday < 1 || day.weekday > 7) {
      throw badRequest(`„${day.weekday}“ ist kein Wochentag (1 = Montag … 7 = Sonntag).`);
    }
    if (byWeekday.has(day.weekday)) {
      throw badRequest(`${WEEKDAY_DE[day.weekday]} steht zweimal in den Öffnungszeiten.`);
    }
    byWeekday.set(day.weekday, day);
  }
  if (byWeekday.size !== 7) {
    throw badRequest(
      'Die Öffnungszeiten werden immer für die ganze Woche gespeichert – bitte alle ' +
        'sieben Tage senden.',
    );
  }

  // Rule 3: shutting the whole week is a different intention from a Ruhetag,
  // and must be stated. Mirrors `confirmNoAllergens` on the menu side.
  const allClosed = [...byWeekday.values()].every((day) => !day.open && !day.close);
  if (allClosed && input.confirmAllClosed !== true) {
    throw badRequest(
      'Damit wäre das Restaurant an jedem Wochentag geschlossen und es könnte niemand ' +
        'mehr bestellen. Wenn das so gewollt ist, bitte bestätigen (confirmAllClosed).',
    );
  }

  assertTime(input.deliveryUntil, '„Lieferung bis“');
  assertWindow(input.holidayOpen, input.holidayClose, 'Feiertage');

  return writeShop(input.version, async (tx) => {
    await tx
      .update(shopProfile)
      .set({
        deliveryUntil: input.deliveryUntil,
        holidayOpen: input.holidayOpen,
        holidayClose: input.holidayClose,
        ruhetagBeatsHoliday: input.ruhetagBeatsHoliday,
      })
      .where(eq(shopProfile.id, 1));

    // The whole week, in one statement, inside the same transaction: the
    // public route can never observe three new days and four old ones.
    await tx.delete(shopWeeklyHours);
    await tx.insert(shopWeeklyHours).values(
      [...byWeekday.values()].map((day) => ({
        weekday: day.weekday,
        open: day.open ?? null,
        close: day.close ?? null,
      })),
    );
  });
}

/** `PUT /api/admin/shop/legal` — the Impressum, and the only writer of `email`. */
export async function saveLegal(input: LegalInput): Promise<AdminShop> {
  if (input.confirmed !== true) {
    throw badRequest(
      'Bitte bestätigen, dass die Angaben im Impressum korrekt und vollständig sind.',
    );
  }
  const email = normaliseEmail(input.email);

  return writeShop(input.version, async (tx) => {
    await tx
      .update(shopProfile)
      .set({
        legalOwnerName: trimOrNull(input.legalOwnerName),
        legalForm: trimOrNull(input.legalForm),
        email,
        vatId: trimOrNull(input.vatId),
        registerCourt: trimOrNull(input.registerCourt),
        registerNumber: trimOrNull(input.registerNumber),
        legalConfirmedAt: new Date(),
      })
      .where(eq(shopProfile.id, 1));
  });
}

function cleanSpecialDay(input: SpecialDayInput): SpecialDayInput {
  return {
    date: trimOrNull(input.date),
    monthDay: trimOrNull(input.monthDay),
    closed: input.closed === true,
    open: trimOrNull(input.open),
    close: trimOrNull(input.close),
    deliveryUntil: trimOrNull(input.deliveryUntil),
    note: input.note?.trim() ?? '',
  };
}

/**
 * `POST /api/admin/shop/special-days` — one or many, in ONE transaction, so
 * "Urlaub eintragen" (up to 62 days) is never half-entered and bumps the
 * version once.
 */
export async function addSpecialDays(
  days: SpecialDayInput[],
  version: number,
): Promise<AdminShop> {
  if (days.length === 0) throw badRequest('Bitte mindestens einen Tag angeben.');
  const cleaned = days.map(cleanSpecialDay);
  for (const day of cleaned) {
    assertSpecialDayShape(day);
    assertNotInThePast(day);
  }
  assertNoDuplicates(cleaned as { date: string | null; monthDay: string | null }[]);

  return writeShop(version, async (tx) => {
    const existing = await tx.select().from(shopSpecialDays);
    for (const day of cleaned) {
      const clash = existing.find((row) =>
        day.date ? row.date === day.date : row.monthDay === day.monthDay,
      );
      if (clash) {
        throw badRequest(
          day.date
            ? `Für den ${day.date} gibt es schon einen Eintrag. Bitte den vorhandenen ändern.`
            : `Für den ${day.monthDay} gibt es schon einen jährlichen Eintrag. Bitte den vorhandenen ändern.`,
        );
      }
    }
    await tx.insert(shopSpecialDays).values(
      cleaned.map((day) => ({
        date: day.date ?? null,
        monthDay: day.monthDay ?? null,
        closed: day.closed,
        open: day.open ?? null,
        close: day.close ?? null,
        deliveryUntil: day.deliveryUntil ?? null,
        note: day.note ?? '',
        // Typed by the owner just now, so it is confirmed by definition.
        confirmed: true,
      })),
    );
  });
}

/**
 * `PATCH /api/admin/shop/special-days/:id` — the whole row. Saving a row also
 * CONFIRMS it, which is how the two seeded D4 defaults lose their
 * "Vorbelegt – bitte prüfen" badge.
 */
export async function updateSpecialDay(
  id: number,
  input: SpecialDayInput,
  version: number,
): Promise<AdminShop> {
  const day = cleanSpecialDay(input);
  assertSpecialDayShape(day);
  assertNotInThePast(day);

  return writeShop(version, async (tx) => {
    const [existing] = await tx
      .select()
      .from(shopSpecialDays)
      .where(eq(shopSpecialDays.id, id));
    if (!existing) throw notFound('Diesen Sondertag gibt es nicht (mehr).');

    const [clash] = await tx
      .select()
      .from(shopSpecialDays)
      .where(
        and(
          ne(shopSpecialDays.id, id),
          day.date
            ? eq(shopSpecialDays.date, day.date)
            : eq(shopSpecialDays.monthDay, day.monthDay as string),
        ),
      );
    if (clash) {
      throw badRequest(
        day.date
          ? `Für den ${day.date} gibt es schon einen Eintrag. Bitte den vorhandenen ändern.`
          : `Für den ${day.monthDay} gibt es schon einen jährlichen Eintrag. Bitte den vorhandenen ändern.`,
      );
    }

    await tx
      .update(shopSpecialDays)
      .set({
        date: day.date ?? null,
        monthDay: day.monthDay ?? null,
        closed: day.closed,
        open: day.open ?? null,
        close: day.close ?? null,
        deliveryUntil: day.deliveryUntil ?? null,
        note: day.note ?? '',
        confirmed: true,
      })
      .where(eq(shopSpecialDays.id, id));
  });
}

/** `DELETE /api/admin/shop/special-days/:id?version=N`. */
export async function deleteSpecialDay(id: number, version: number): Promise<AdminShop> {
  return writeShop(version, async (tx) => {
    const deleted = await tx
      .delete(shopSpecialDays)
      .where(eq(shopSpecialDays.id, id))
      .returning({ id: shopSpecialDays.id });
    if (deleted.length === 0) throw notFound('Diesen Sondertag gibt es nicht (mehr).');
  });
}

/**
 * `POST /api/admin/shop/undo` — restore the most recent `before` snapshot.
 *
 * The undo is recorded as a change of its own, so pressing it twice is a redo.
 * It re-checks the structural invariants but NOT "no dated day in the past":
 * that rule is about new entries, and applying it here would make an undo fail
 * after midnight, exactly when a mistaken Urlaub most needs taking back.
 */
export async function undoLastChange(version: number): Promise<AdminShop> {
  return writeShop(version, async (tx) => {
    const [last] = await tx
      .select()
      .from(adminChanges)
      .where(eq(adminChanges.entity, SHOP_ENTITY))
      .orderBy(desc(adminChanges.id))
      .limit(1);
    if (!last || !last.before) {
      throw badRequest('Es gibt nichts rückgängig zu machen.');
    }

    const target = last.before as ShopSnapshot;
    assertSnapshotIsSound(target);
    await restore(tx, target);
  });
}

async function restore(tx: Tx, target: ShopSnapshot): Promise<void> {
  await tx
    .update(shopProfile)
    .set({
      name: target.profile.name,
      street: target.profile.street,
      postalCode: target.profile.postalCode,
      city: target.profile.city,
      phoneDisplay: target.profile.phoneDisplay,
      phoneE164: target.profile.phoneE164,
      email: target.profile.email,
      deliveryUntil: target.profile.deliveryUntil,
      holidayOpen: target.profile.holidayOpen,
      holidayClose: target.profile.holidayClose,
      ruhetagBeatsHoliday: target.profile.ruhetagBeatsHoliday,
      legalOwnerName: target.profile.legalOwnerName,
      legalForm: target.profile.legalForm,
      vatId: target.profile.vatId,
      registerCourt: target.profile.registerCourt,
      registerNumber: target.profile.registerNumber,
      legalConfirmedAt: target.profile.legalConfirmedAt
        ? new Date(target.profile.legalConfirmedAt)
        : null,
    })
    .where(eq(shopProfile.id, 1));

  await tx.delete(shopWeeklyHours);
  if (target.weekly.length > 0) {
    await tx.insert(shopWeeklyHours).values(
      target.weekly.map((day) => ({
        weekday: day.weekday,
        open: day.open,
        close: day.close,
      })),
    );
  }

  // The ids are restored with the rows, so a special day the editor is holding
  // on screen keeps the id its next PATCH will name. The sequence is moved
  // past them afterwards, or the next INSERT would collide with a restored id.
  await tx.delete(shopSpecialDays);
  if (target.specialDays.length > 0) {
    await tx.insert(shopSpecialDays).values(
      target.specialDays.map((day) => ({
        id: day.id,
        date: day.date,
        monthDay: day.monthDay,
        closed: day.closed,
        open: day.open,
        close: day.close,
        deliveryUntil: day.deliveryUntil,
        note: day.note,
        confirmed: day.confirmed,
      })),
    );
    await tx.execute(drizzleSql`
      select setval(
        pg_get_serial_sequence('shop_special_days', 'id'),
        (select max(id) from shop_special_days)
      )
    `);
  }
}

// --- The preview ------------------------------------------------------------

/**
 * `POST /api/admin/shop/preview` — what a diner would see if this draft were
 * saved. It writes NOTHING and needs no version: it overlays the draft on the
 * stored rows and runs the same functions the public route runs, so
 * `preview.status` is the status `GET /api/shop` will serve after the save.
 */
export async function previewShop(draft: PreviewDraft): Promise<ShopPreview> {
  const { profile, weekly, specialDays } = await readRows(db);
  if (!profile) throw serviceUnavailable(MISSING_SHOP);
  const stored = rulesFromRows(profile, weekly, specialDays);
  const rules = applyDraft(stored, draft);

  const instant = now();
  const local = berlinTime(instant);
  const days: DayHours[] = [];
  for (let offset = 0; offset <= 7; offset += 1) {
    const [y, m, d] = shiftDate(local.year, local.month, local.day, offset)
      .split('-')
      .map(Number) as [number, number, number];
    days.push(hoursOn(rules, y, m, d));
  }

  return {
    display: displayHours(rules),
    status: shopStatus(rules, instant),
    days,
  };
}

/** Overlay a draft on the stored rules. An omitted part keeps its stored value. */
function applyDraft(stored: ShopRules, draft: PreviewDraft): ShopRules {
  const rules: ShopRules = {
    ...stored,
    weekly: { ...stored.weekly },
    holiday: { ...stored.holiday },
  };

  if (draft.weekly) {
    const week: Record<number, { open: string; close: string } | null> = {};
    for (let weekday = 1; weekday <= 7; weekday += 1) week[weekday] = null;
    for (const day of draft.weekly) {
      if (!Number.isInteger(day.weekday) || day.weekday < 1 || day.weekday > 7) {
        throw badRequest(`„${day.weekday}“ ist kein Wochentag (1 = Montag … 7 = Sonntag).`);
      }
      if (day.open && day.close) {
        assertWindow(day.open, day.close, WEEKDAY_DE[day.weekday] ?? `Wochentag ${day.weekday}`);
        week[day.weekday] = { open: day.open, close: day.close };
      } else if (day.open || day.close) {
        throw badRequest(
          `${WEEKDAY_DE[day.weekday] ?? day.weekday}: bitte Öffnungs- UND Schließzeit angeben, ` +
            'oder den Tag als Ruhetag speichern.',
        );
      }
    }
    rules.weekly = week;
  }

  if (draft.deliveryUntil !== undefined) {
    assertTime(draft.deliveryUntil, '„Lieferung bis“');
    rules.deliveryUntil = draft.deliveryUntil;
  }
  if (draft.holidayOpen !== undefined || draft.holidayClose !== undefined) {
    const open = draft.holidayOpen ?? stored.holiday.open;
    const close = draft.holidayClose ?? stored.holiday.close;
    assertWindow(open, close, 'Feiertage');
    rules.holiday = { open, close };
  }
  if (draft.ruhetagBeatsHoliday !== undefined) {
    rules.ruhetagBeatsHoliday = draft.ruhetagBeatsHoliday;
  }
  if (draft.specialDays) {
    const cleaned = draft.specialDays.map(cleanSpecialDay);
    for (const day of cleaned) assertSpecialDayShape(day);
    assertNoDuplicates(cleaned as { date: string | null; monthDay: string | null }[]);
    rules.specialDays = cleaned.map(
      (day): SpecialDayRule => ({
        date: day.date ?? null,
        monthDay: day.monthDay ?? null,
        closed: day.closed,
        open: day.open ?? null,
        close: day.close ?? null,
        deliveryUntil: day.deliveryUntil ?? null,
        note: day.note ?? '',
        confirmed: true,
      }),
    );
  }

  return rules;
}
