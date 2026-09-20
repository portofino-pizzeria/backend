// Decision D5 — answering a data-subject request.
//
// Art. 15 (Auskunft) and Art. 17 (Löschung) requests arrive by phone or by
// email, to the owner, who is the person answering the phone. Before this,
// answering one meant asking a developer to run SQL. That is not a process, and
// "we will respond within a month" is not a promise a restaurant can keep by
// escalating to an engineer.
//
// Three operations, all behind the owner's existing credential:
//
//   findOrdersByPhone   — the only identifier a caller can give over the phone
//   personalDataExtract — the Art. 15 extract for one order
//   forgetOrder         — Art. 17, keeping the books
//
// What `forgetOrder` does NOT reach, and what the German around it must
// therefore not promise:
//
//   * **Stripe.** Stripe holds its own record of the payment — the session,
//     the diner's email and card details, `metadata.orderId` and
//     `client_reference_id` — and `orders.payment_reference` stays as a link
//     into it for the full commercial-retention period. A diner who wants that
//     erased has to address Stripe too, and the extract says so.
//   * **The 7-day backup window.** Aurora's automated backups
//     (`infra/database.tf`, `backup_retention_period = 7`) can still restore a
//     NULLed column for up to a week.
//   * **The diner's own device.** That is what "Gespeicherte Angaben löschen"
//     in checkout is for.

import { and, desc, eq, isNotNull, isNull, notInArray, sql as raw } from 'drizzle-orm';

import { config } from '../config.js';
import { now } from './clock.js';
import { db } from '../db/client.js';
import { orderLines, orders, type OrderRow } from '../db/schema.js';
import type { Fulfilment, OrderStatus, PaymentProvider } from '../types.js';
import { badRequest, conflict, notFound } from './http-errors.js';

/**
 * Digits a phone search must carry. The same floor `POST /api/orders` puts on
 * a phone number: enough to be a number rather than a fragment, and — because
 * the match is a SUFFIX match, below — low enough that a caller reading out
 * the local part of their number is found.
 */
export const MIN_SEARCH_DIGITS = 6;

/** One row of the owner's phone-number search. */
export interface OrderSearchHit {
  id: string;
  createdAt: string;
  status: OrderStatus;
  fulfilment: Fulfilment;
  total: number;
  currency: string;
  name: string | null;
  phone: string | null;
  address: string | null;
  personalDataErasedAt: string | null;
}

/**
 * Find a diner's orders by phone number.
 *
 * The comparison is on DIGITS ONLY, as a suffix. Stored numbers are free text
 * — `0201 5415883`, `+49 201 5415883` and `0201/5415883` are all the same
 * phone — so an exact match would answer "no orders" to a diner who typed
 * their number differently from how they said it. A suffix match on digits
 * makes all three forms find each other, and it is what a phone call actually
 * gives you: the caller reads out the end of their number.
 *
 * Capped, and newest first: this is a lookup, not a report.
 */
export async function findOrdersByPhone(phone: string): Promise<OrderSearchHit[]> {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < MIN_SEARCH_DIGITS) {
    throw badRequest(
      `Bitte mindestens ${MIN_SEARCH_DIGITS} Ziffern der Telefonnummer angeben.`,
    );
  }

  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        isNotNull(orders.customerPhone),
        raw`regexp_replace(${orders.customerPhone}, '[^0-9]', '', 'g') like ${'%' + digits}`,
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(50);

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    status: row.status as OrderStatus,
    fulfilment: row.fulfilment === 'pickup' ? 'pickup' : 'delivery',
    total: row.total,
    currency: row.currency,
    name: row.customerName,
    phone: row.customerPhone,
    address: row.customerAddress,
    personalDataErasedAt: row.personalDataErasedAt?.toISOString() ?? null,
  }));
}

/** The Art. 15 extract for one order. */
export interface PersonalDataExtract {
  orderId: string;
  createdAt: string;
  updatedAt: string;
  status: OrderStatus;
  fulfilment: Fulfilment;
  /** Exactly the four columns that hold personal data. `null` where empty. */
  customer: {
    name: string | null;
    phone: string | null;
    address: string | null;
    notes: string | null;
  };
  order: {
    subtotal: number;
    deliveryFee: number;
    total: number;
    currency: string;
    lines: {
      name: string;
      variantLabel: string;
      unitPrice: number;
      quantity: number;
    }[];
  };
  payment: {
    provider: PaymentProvider | null;
    reference: string | null;
    paidAt: string | null;
  };
  personalDataErasedAt: string | null;
  /**
   * What this extract does not and cannot contain, in German, for the owner to
   * read out or forward. An Art. 15 answer that quietly omits a second
   * controller is an incomplete answer.
   */
  hinweise: string[];
}

const EXTRACT_HINWEISE = [
  'Diese Auskunft umfasst alle personenbezogenen Daten, die Portofino zu dieser ' +
    'Bestellung auf dem eigenen Server speichert.',
  'Die Zahlung wurde über Stripe abgewickelt. Stripe speichert dazu eigene Daten ' +
    '(Zahlungssitzung, E-Mail-Adresse, Kartendaten) und ist dafür selbst ' +
    'verantwortlich. Eine Auskunft oder Löschung dieser Daten ist direkt bei ' +
    'Stripe zu beantragen.',
  'Name, Telefonnummer und Adresse, die im Browser oder in der App unter ' +
    '„Angaben merken" gespeichert wurden, liegen nur auf dem Gerät und können ' +
    'dort über „Gespeicherte Angaben löschen" entfernt werden.',
  'Gelöschte Felder können bis zu 7 Tage lang noch in einer automatischen ' +
    'Datenbank-Sicherung enthalten sein.',
];

/**
 * Why a months-old order's phone, address and note are already empty.
 *
 * Without this, an extract for a seven-month-old order shows three nulls, no
 * erasure timestamp and four notes about Stripe — and reads like a bug to the
 * person answering the phone. D4 makes that the COMMON case, so the extract
 * has to explain it.
 */
function retentionHinweis(): string {
  return (
    `Telefonnummer, Adresse und Notiz werden ${config.retention.contactMonths} Monate ` +
    'nach der Bestellung automatisch gelöscht; der Name und die Bestellung selbst ' +
    `bleiben für die gesetzliche Aufbewahrung (${config.retention.orderYears} Jahre) ` +
    'erhalten. Leere Felder bei einer älteren Bestellung sind deshalb normal und ' +
    'kein Fehler.'
  );
}

export async function personalDataExtract(
  id: string,
): Promise<PersonalDataExtract> {
  const row = await requireOrder(id);
  const lines = await db
    .select()
    .from(orderLines)
    .where(eq(orderLines.orderId, id));

  return {
    orderId: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    status: row.status as OrderStatus,
    fulfilment: row.fulfilment === 'pickup' ? 'pickup' : 'delivery',
    customer: {
      name: row.customerName,
      phone: row.customerPhone,
      address: row.customerAddress,
      notes: row.customerNotes,
    },
    order: {
      subtotal: row.subtotal,
      deliveryFee: row.deliveryFee,
      total: row.total,
      currency: row.currency,
      lines: lines.map((l) => ({
        name: l.name,
        variantLabel: l.variantLabel,
        unitPrice: l.unitPrice,
        quantity: l.quantity,
      })),
    },
    payment: {
      provider: (row.paymentProvider as PaymentProvider | null) ?? null,
      reference: row.paymentReference,
      paidAt: row.paidAt?.toISOString() ?? null,
    },
    personalDataErasedAt: row.personalDataErasedAt?.toISOString() ?? null,
    hinweise: [...EXTRACT_HINWEISE, retentionHinweis()],
  };
}

/**
 * The statuses `forget` refuses, and why.
 *
 * The refusal exists to protect a delivery in flight: erasing the address of
 * an order the kitchen is cooking would strand the food. So it is exactly the
 * two states where that is true.
 *
 * `pending_payment` is deliberately NOT among them, and that is a decision
 * rather than an oversight. An abandoned unpaid order never leaves
 * `pending_payment` except by a kitchen cancel, so refusing it would make
 * those orders permanently un-erasable on request — the one outcome Art. 17
 * does not allow. An unpaid order strands no food.
 *
 * `ready` and `cancelled` are the terminal states (the only two with no
 * successors in `NEXT`, `order-service.ts`). There is no `completed` or
 * `delivered` status.
 */
const FORGET_REFUSED: Record<string, string> = {
  paid: 'Diese Bestellung ist bezahlt und noch nicht fertig. Die Kontaktdaten werden ' +
    'noch für die Zubereitung und Lieferung gebraucht. Bitte die Bestellung zuerst ' +
    'abschließen oder stornieren.',
  preparing: 'Diese Bestellung wird gerade zubereitet. Die Kontaktdaten werden noch für ' +
    'die Lieferung gebraucht. Bitte die Bestellung zuerst abschließen oder stornieren.',
};

export interface ForgetResult {
  orderId: string;
  /** False when the order had already been erased — the call is idempotent. */
  erased: boolean;
  /** The FIRST erasure's timestamp, never overwritten by a repeat call. */
  personalDataErasedAt: string;
  /** German, for the admin screen to show verbatim. */
  meldung: string;
}

/**
 * Art. 17 for one order.
 *
 * NULLs all four customer columns and stamps `personal_data_erased_at`, keeping
 * the order, its lines and its totals so the books stay intact. `order_lines`
 * carries no personal data and `serializeOrder` omits `order.customer`
 * entirely when all four columns are empty, so the kitchen card degrades to its
 * existing "Keine Kontaktdaten hinterlegt" state with the total, the lines and
 * the history still shown.
 */
export async function forgetOrder(id: string): Promise<ForgetResult> {
  const at = now();

  // ONE statement decides and writes. A read-then-write would be a TOCTOU on
  // both guards at once: the kitchen could move the order to `preparing`
  // between the status check and the UPDATE — erasing the address of a
  // delivery in flight, the exact outcome the refusal exists to prevent — and
  // two concurrent calls would both see `personal_data_erased_at IS NULL` and
  // both write, overwriting the first erasure's timestamp this function
  // promises never to move.
  //
  // So the predicate carries the guards, and the returned row count tells us
  // which branch actually happened.
  const [erased] = await db
    .update(orders)
    .set({
      customerName: null,
      customerPhone: null,
      customerAddress: null,
      customerNotes: null,
      personalDataErasedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(orders.id, id),
        isNull(orders.personalDataErasedAt),
        notInArray(orders.status, Object.keys(FORGET_REFUSED)),
      ),
    )
    .returning({ id: orders.id });

  if (!erased) {
    // Nothing was written. Re-read to say WHY — the order is unknown, already
    // erased, or in a state that refuses. This read races nothing: every
    // outcome it reports is one where no write happened.
    const row = await requireOrder(id);

    const refusal = FORGET_REFUSED[row.status];
    if (refusal) throw conflict(refusal);

    if (row.personalDataErasedAt) {
      return {
        orderId: row.id,
        erased: false,
        personalDataErasedAt: row.personalDataErasedAt.toISOString(),
        meldung:
          'Die Kontaktdaten dieser Bestellung wurden bereits gelöscht. Es wurde nichts ' +
          'weiter geändert.',
      };
    }

    // Neither guard explains it, so the row changed under us between the
    // UPDATE and this read. Refusing is the safe answer; a retry succeeds.
    throw conflict(
      'Diese Bestellung hat sich gerade geändert. Bitte noch einmal versuchen.',
    );
  }

  return {
    orderId: id,
    erased: true,
    personalDataErasedAt: at.toISOString(),
    meldung:
      'Name, Telefonnummer, Adresse und Notiz wurden gelöscht. Die Bestellung selbst, ' +
      'ihre Positionen und die Beträge bleiben für die gesetzliche Aufbewahrung ' +
      'erhalten. Nicht betroffen sind: die Daten bei Stripe (dort separat beantragen), ' +
      'automatische Datenbank-Sicherungen der letzten 7 Tage, und die Angaben auf dem ' +
      'Gerät der Kundin oder des Kunden.',
  };
}

async function requireOrder(id: string): Promise<OrderRow> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw notFound('Diese Bestellung gibt es nicht.');
  return row;
}
