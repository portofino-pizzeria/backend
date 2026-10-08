// The delivery area: the postcodes the shop delivers to, set by the owner in
// the restaurant editor (`PUT /api/admin/shop/delivery-area`).
//
// An EMPTY list means "no restriction" — every address is accepted, which is
// how the shop worked before the area existed and what a fresh install does
// until the owner enters one. A non-empty list is enforced at order time
// (`createOrder`): a delivery address must name one of these postcodes.
//
// The address is one free-text field ("Straße Nr., PLZ Ort"), so the postcode
// is read OUT of it: a run of exactly five digits. That is the German postcode
// shape and nothing else in a street address has it — a house number is at
// most four digits, and a five-digit house number would still be refused
// rather than accepted by mistake, because it must also be on the list.

import { badRequest } from './http-errors.js';

const POSTCODE = /^\d{5}$/;
const POSTCODE_IN_TEXT = /(?<!\d)\d{5}(?!\d)/g;

/** More than any delivery area a pizzeria serves; bounds a pasted list. */
const MAX_POSTCODES = 200;

/**
 * The owner's list as stored: trimmed, validated, de-duplicated and sorted.
 * Refuses the whole list, naming the first entry that is not a postcode, so
 * a typo is never silently dropped from the area.
 */
export function normalisePostcodes(input: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of input) {
    const code = raw.trim();
    if (!code) continue;
    if (!POSTCODE.test(code)) {
      throw badRequest(`„${code}“ ist keine Postleitzahl. Bitte fünf Ziffern angeben, z. B. 45219.`);
    }
    out.add(code);
  }
  if (out.size > MAX_POSTCODES) {
    throw badRequest(`Höchstens ${MAX_POSTCODES} Postleitzahlen.`);
  }
  return [...out].sort();
}

/** Every postcode-shaped number in a free-text address, in order. */
export function postcodesIn(address: string): string[] {
  return address.match(POSTCODE_IN_TEXT) ?? [];
}

/**
 * The German sentence a diner reads when a delivery to this address is
 * refused, or `null` when it is taken. Pickup is named as the alternative.
 */
export function deliveryAreaRefusal(area: readonly string[], address: string): string | null {
  if (area.length === 0) return null;
  const found = postcodesIn(address);
  if (found.length === 0) {
    return 'Bitte gib in der Lieferadresse auch die Postleitzahl an, z. B. „Hauptstr. 1, 45219 Essen“.';
  }
  if (found.some((code) => area.includes(code))) return null;
  return (
    `Nach ${found[found.length - 1]} liefern wir leider nicht. ` +
    `Wir liefern in die Postleitzahlen ${area.join(', ')}. Abholung ist natürlich möglich.`
  );
}
