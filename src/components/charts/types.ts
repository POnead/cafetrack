/**
 * The shapes the charts are drawn from.
 *
 * These are the chart's own inputs, not the database's rows: the numbers
 * have already been counted and totalled by the time a chart sees them, so a
 * chart never has to know what a transaction is.
 */

/** Stock quantity for one category. */
export type CategoryDatum = {
  name: string;
  /** Total quantity on hand across the category, in the categories' own units. */
  quantity: number;
  /** How many items the category holds. */
  items: number;
};

/** One stock state and how many items are in it. */
export type StatusDatum = {
  key: string;
  label: string;
  count: number;
  color: string;
};

/** One entry in a ranked horizontal bar chart. */
export type BarDatum = {
  /** Stable identity of the row — the SKU, or the name for group rows. */
  key: string;
  name: string;
  /** The measured value — the bar's length. */
  value: number;
  /** How the value should be written beside the bar. */
  label: string;
  /** A second line, such as the SKU. */
  detail?: string;
  /** The unit the value is counted in, when there is one. */
  unit?: string | null;
  /** The item's SKU, when the row is about one item. */
  sku?: string;
  /**
   * True when the SKU no longer exists in the catalogue. The ranked lists
   * prefer the current catalogue name; archived rows keep their historical
   * name and are tagged as archived.
   */
  archived?: boolean;
};

/** Stock in and stock out for one period. */
export type MovementDatum = {
  key: string;
  label: string;
  stockIn: number;
  stockOut: number;
};

/** Checkout value and waste cost for one period. */
export type ValueTrendDatum = {
  key: string;
  label: string;
  revenueCents: number;
  lossCents: number;
};

/** One value band in the transaction distribution. */
export type HistogramDatum = {
  label: string;
  minCents: number;
  maxCents: number;
  checkoutCount: number;
  wasteCount: number;
};

/** One item's checkout and waste event counts. */
export type ScatterDatum = {
  sku: string;
  name: string;
  checkoutEvents: number;
  wasteEvents: number;
};

/** One slice of a value breakdown, with the items that make it up. */
export type MoneySlice = {
  key: string;
  name: string;
  valueCents: number;
  items: {
    sku: string;
    name: string;
    quantity: number;
    unitPrice: number;
    valueCents: number;
  }[];
};

/** One kind of movement and how often it happened. */
export type ActivitySlice = {
  type: string;
  label: string;
  count: number;
  qty: number;
  color: string;
};

/** Waste transactions in one period. */
export type WasteEventDatum = {
  key: string;
  label: string;
  /** How many waste records were logged in this bucket. */
  events: number;
};
