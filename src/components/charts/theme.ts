/**
 * Chart palette and the formatters the charts share.
 *
 * The colours are the ones the application already uses, taken from
 * `tailwind.config.ts` rather than picked again here, so a chart and the
 * status tag beside it cannot drift apart:
 *
 *   sage-500       normal stock, stock in
 *   ochre-500      low stock
 *   terracotta-500 out of stock
 *   rust-500       stock out, waste cost
 *   cocoa-500      checkout value, any single-measure series
 *
 * One measure gets one colour. The only place a multi-colour palette appears
 * is a breakdown of one total across many parts, where the parts have to be
 * told apart — revenue by item, for instance.
 */
export const CHART_COLORS = {
  /** Normal stock, and stock coming in. */
  normal: "#6B8F5A",
  /** Stock below its reorder threshold. */
  low: "#B8862F",
  /** Stock at zero. */
  out: "#B5603E",
  /** Stock leaving the shelf. */
  stockOut: "#8B3A24",
  /** Checkout value. */
  revenue: "#8D6040",
  /** Waste cost. */
  waste: "#8B3A24",
  /** Any single-measure series. */
  primary: "#8D6040",
  /** A secondary measure in the same chart. */
  neutral: "#BD8C53",
  /** Grid lines and axis rules. */
  grid: "#EADBC8",
  /** Axis label text. */
  axis: "#8A7B6D",
} as const;

/**
 * The warm palette used where one total is split across many parts and the
 * parts have to be told apart. Kept in the same order the reports page has
 * always used so the slices do not jump between versions.
 */
export const MONEY_SERIES = [
  "#8d6040",
  "#bd8c53",
  "#9b6f4a",
  "#8b3a24",
  "#c8a274",
  "#70482d",
  "#b8862f",
  "#a67642",
] as const;

/** A whole number with thousands separators. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-PH");
}

/** The colour a kind of movement is drawn in. */
export const ACTIVITY_COLORS: Record<string, string> = {
  checkout: CHART_COLORS.revenue,
  restock: CHART_COLORS.normal,
  waste: CHART_COLORS.stockOut,
};

/**
 * A count or an amount with its unit, for a tooltip row.
 *
 * Quantities come in mixed units across a cafe — pieces, litres, kilograms,
 * cans — so a quantity is shown with its own unit rather than as a bare
 * number, and a sum across mixed units is never presented as one quantity.
 */
export function formatQuantity(value: number, unit?: string | null): string {
  const rounded = Math.round(value * 100) / 100;
  const number = Number.isInteger(rounded)
    ? rounded.toLocaleString("en-PH")
    : rounded.toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  return unit ? `${number} ${unit}` : number;
}

/** A short axis label for a category name that may be long. */
export function truncateLabel(value: string, max = 18): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
