// Domain types — the API's public contract. These MUST stay in sync with the
// mobile app's mirror at mobile/src/lib/types.ts. Money is always an integer
// number of cents.
//
// German is authoritative throughout: `label` / `name` / `description` hold the
// text as Portofino prints it, and the `*En` fields are optional additions. A
// missing translation renders the German, never a gap.

/** A menu category. Data, not a closed union — the owner adds and reorders
 *  these, and the API returns them in the order they should be rendered. */
export interface MenuCategory {
  id: string;
  label: string;
  labelEn?: string;
  sortOrder: number;
}

/** One real purchasable thing: a size ("klein"/"groß"/"Blech") or a meat
 *  choice ("Schwein"/"Pute"). An item with a single price has exactly one
 *  variant. `price` is always present — a variant without a price cannot
 *  exist. */
export interface MenuVariant {
  id: string;
  label: string;
  sortOrder: number;
  price: number;
}

export interface MenuItem {
  id: string;
  /** The number printed on the menu ("1", "76a"). Absent if the menu does not
   *  number this item — never invented. */
  number?: string;
  name: string;
  nameEn?: string;
  description: string;
  descriptionEn?: string;
  categoryId: string;
  /** At least one, in render order. Prices live here, never on the item. */
  variants: MenuVariant[];
  /** Verbatim as printed. Resolve against `Menu.allergenLegend`; every code
   *  here has an entry there, possibly an unresolved one. */
  allergenCodes: string[];
  imageUrl?: string;
  /** Sold only to diners who collect ("für Selbstabholer"). Absent = false. */
  pickupOnly?: boolean;
}

/** A legend entry for one allergen code. `resolved: false` means Portofino
 *  prints this code but we have no label for it — the entry is still returned,
 *  carrying the explicit "unbekannt" label. Codes are never dropped. */
export interface AllergenLegendEntry {
  code: string;
  label: string;
  labelEn?: string;
  resolved: boolean;
}

/** The GET /api/menu payload. */
export interface Menu {
  categories: MenuCategory[];
  items: MenuItem[];
  allergenLegend: AllergenLegendEntry[];
}

/** An item as the owner's editor sees it: everything a diner sees, plus the
 *  two fields that decide whether a diner sees it at all. `available: false`
 *  items are absent from `Menu` and present here — the editor cannot bring an
 *  item back that it cannot see. */
export interface AdminMenuItem extends MenuItem {
  available: boolean;
  sortOrder: number;
}

/** The GET /api/admin/menu payload — the same three collections as `Menu`, so
 *  the editor renders the domain shapes the public API already defines. */
export interface AdminMenu {
  categories: MenuCategory[];
  items: AdminMenuItem[];
  allergenLegend: AllergenLegendEntry[];
}

export type PaymentProvider = 'stripe' | 'paypal' | 'mock';

/** How the diner gets the food. A pickup pays no delivery fee and gives no address. */
export type Fulfilment = 'delivery' | 'pickup';

export type OrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'preparing'
  | 'ready'
  | 'cancelled';

/** Snapshotted at order time, so a historical order still reads
 *  "Margherita, groß" at the price that was charged. */
export interface OrderLine {
  menuItemId: string;
  variantId: string;
  name: string;
  variantLabel: string;
  unitPrice: number;
  quantity: number;
}

export interface CustomerInfo {
  name?: string;
  phone?: string;
  address?: string;
  notes?: string;
}

export interface Order {
  id: string;
  lines: OrderLine[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  currency: string;
  fulfilment: Fulfilment;
  status: OrderStatus;
  customer?: CustomerInfo;
  /**
   * Set — and only ever set to `true` — when the customer block was WITHHELD
   * because the caller presented no order access token (decision D3).
   *
   * It exists so a client can tell "we are not showing you this" apart from
   * "there is nothing to show". Without it, the order screen's
   * `deliveryDetails()` renders a red *"Keine Lieferadresse hinterlegt"* on
   * every un-tokened delivery order — turning a privacy improvement into a
   * visible error. Absent on an authorised read and on any order that genuinely
   * carries no customer data (an erased one, see D5).
   */
  customerRedacted?: true;
  payment?: { provider: PaymentProvider; reference?: string; paidAt?: string };
  createdAt: string;
  updatedAt: string;
}

/**
 * The legal notice (Impressum) facts `GET /api/shop` serves, § 5 DDG.
 *
 * Every one of them may be `null`: none appears in any document this
 * repository can read, and an invented legal name would be worse than a gap
 * the app can name. `complete` and `missing` say which, so the Impressum page
 * can render what is known and say what is not — and so `/api/health` can
 * report the gap to a deploy. `vatId` and the register fields are OMITTED
 * rather than null when unset, because for an Einzelunternehmen they normally
 * do not apply at all.
 */
export interface ShopLegal {
  ownerName: string | null;
  legalForm: string | null;
  email: string | null;
  vatId?: string;
  registerCourt?: string;
  registerNumber?: string;
  /** `ownerName` and `email` are both set. */
  complete: boolean;
  /** e.g. `["legalOwnerName", "email"]`. */
  missing: string[];
}

/**
 * The `POST /api/orders` response.
 *
 * `accessToken` is returned HERE and nowhere else — this is the one moment the
 * capability from D3 is handed out. It is deliberately not a field of `Order`:
 * `Order` is read back by `GET /api/orders/:id`, by the kitchen board and by
 * the payment result pages, and a secret on that shape would be re-served on
 * every one of them.
 */
export interface CreatedOrder {
  order: Order;
  accessToken: string;
}
