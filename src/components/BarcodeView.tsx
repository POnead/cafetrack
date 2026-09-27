"use client";

import { useEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";

export type BarcodeLabel = { value: string; title: string; subtitle?: string };

/**
 * Code 128 is the inventory standard: every handheld scanner reads it, it
 * carries far more characters per square centimetre than a QR code, and it
 * stays legible on a small, cheap label.
 *
 * The one rule that decides whether a printed barcode scans is bar width: it
 * has to be a whole number of printer dots. A fractional, or CSS-scaled,
 * barcode is the usual reason a scanner refuses a label that looks perfect on
 * screen. So every barcode here is measured first and drawn at an exact
 * integer module width that fits the space available.
 */
const OPTIONS = {
  format: "CODE128",
  lineColor: "#3D2B1F",
  background: "#FFFFFF",
  font: "ui-monospace, monospace",
  fontOptions: "bold",
  fontSize: 13,
  textMargin: 2,
  displayValue: true,
  height: 55,
} as const;

/** Quiet zone around the bars. Code 128 wants at least 10x the module width. */
const MARGIN = 10;

/**
 * Modules a value needs, measured without rendering. JsBarcode will fill a
 * plain object instead of a DOM element, which is how the width is known before
 * anything is drawn.
 *
 * Code 128 in set B (which covers every SKU and staff code we generate) is
 * start(11) + value(11 per char) + checksum(11) + stop(13).
 */
export function barcodeModuleCount(value: string): number | null {
  if (!value) return null;

  const probe: { encodings?: { data?: string }[] } = {};
  try {
    JsBarcode(probe, value, {
      ...OPTIONS,
      width: 1,
      margin: 0,
      height: 1,
      displayValue: false,
    });
  } catch {
    return null;
  }

  const encodings = probe.encodings;
  if (!Array.isArray(encodings) || encodings.length === 0) return null;

  // jsbarcode 3.x calls the bar pattern `data`; it is a run of "0"/"1", one
  // character per module.
  const modules = encodings.reduce(
    (total, encoding) => total + String(encoding?.data ?? "").length,
    0
  );
  return modules > 0 ? modules : null;
}

/**
 * Largest whole-number module width that still fits `targetWidth`.
 *
 * A module can never be thinner than one pixel, so a code that is too long for
 * the space cannot be shrunk to fit. Rather than quietly overflowing, `fits`
 * says so and the caller decides: the label is printed wider, or the operator
 * is told the code needs a bigger label.
 */
export function fitBarcode(
  value: string,
  targetWidth: number
): { modules: number; moduleWidth: number; width: number; fits: boolean } | null {
  const modules = barcodeModuleCount(value);
  if (!modules) return null;

  const moduleWidth = Math.max(1, Math.floor((targetWidth - 2 * MARGIN) / modules));
  const width = modules * moduleWidth + 2 * MARGIN;
  return { modules, moduleWidth, width, fits: width <= targetWidth };
}

function draw(
  target: SVGSVGElement,
  value: string,
  moduleWidth: number,
  width: number
) {
  JsBarcode(target, value, { ...OPTIONS, width: moduleWidth, margin: MARGIN });
  // JsBarcode normally sets this itself; belt and braces so the browser never
  // falls back to the 300x150 default and scales the bars.
  if (!target.getAttribute("width")) target.setAttribute("width", String(width));
}

/* ------------------------------------------------------------------ */
/* On-screen preview                                                    */
/* ------------------------------------------------------------------ */

export function BarcodeView({
  value,
  width = 260,
  label,
}: {
  value: string;
  width?: number;
  label?: string;
}) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tooLong, setTooLong] = useState(false);

  useEffect(() => {
    const target = ref.current;
    if (!target) return;

    const fit = fitBarcode(value, width);
    if (!fit) {
      setError(`"${value}" cannot be encoded as a Code 128 barcode.`);
      return;
    }

    try {
      draw(target, value, fit.moduleWidth, fit.width);
      setError(null);
      setTooLong(!fit.fits);
    } catch {
      setError(`"${value}" cannot be encoded as a Code 128 barcode.`);
    }
  }, [value, width]);

  return (
    <div className="inline-flex flex-col items-center gap-2">
      <svg
        ref={ref}
        role="img"
        aria-label={label || `Barcode for ${value}`}
        className="rounded-xl border border-cream-200 bg-white p-1"
      />
      <code className="font-mono text-xs text-cocoa-400">{value}</code>
      {tooLong && (
        <p className="max-w-[16rem] text-[11px] text-amber-700">
          Long code: the bars cannot be made any thinner, so this label is
          wider than a standard sticker.
        </p>
      )}
      {error && <p className="max-w-[16rem] text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Print sheet                                                          */
/* ------------------------------------------------------------------ */

/** Barcode area for printed labels, in CSS pixels (~46mm wide on A4). */
const PRINT_WIDTH = 320;
const LABEL_PADDING = 14;

/**
 * Builds one label per entry, then opens a print-ready window. The print window
 * is a separate document, so every barcode has to be drawn into it before the
 * markup is written.
 */
export async function printBarcodeLabelsAsync(labels: BarcodeLabel[]) {
  if (labels.length === 0) return;

  const cards: string[] = [];
  const skipped: string[] = [];
  const oversized: string[] = [];

  for (const label of labels) {
    const fit = fitBarcode(label.value, PRINT_WIDTH);
    if (!fit) {
      skipped.push(label.value);
      continue;
    }
    if (!fit.fits) oversized.push(label.value);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    draw(svg, label.value, fit.moduleWidth, fit.width);

    // Vector, so the printer draws the bars itself — nothing is resampled.
    const markup = new XMLSerializer().serializeToString(svg);

    cards.push(`
      <div class="label" style="width:${fit.width + LABEL_PADDING * 2}px">
        <div class="title">${escapeHtml(label.title)}</div>
        ${label.subtitle ? `<div class="sub">${escapeHtml(label.subtitle)}</div>` : ""}
        <div class="bars">${markup}</div>
        <div class="code">${escapeHtml(label.value)}</div>
      </div>`);
  }

  if (cards.length === 0) {
    alert("None of those codes can be printed as a Code 128 barcode.");
    return;
  }

  const win = window.open("", "_blank", "width=800,height=900");
  if (!win) {
    alert("Pop-up blocked. Allow pop-ups for this site to print barcode labels.");
    return;
  }

  const warning =
    (skipped.length
      ? `<div class="no-print skipped">Skipped (not encodable): ${escapeHtml(
          skipped.join(", ")
        )}</div>`
      : "") +
    (oversized.length
      ? `<div class="no-print skipped">Wider than a standard label: ${escapeHtml(
          oversized.join(", ")
        )}</div>`
      : "");

  win.document.write(`
    <html>
      <head>
        <title>CafeTrack — Barcode Labels</title>
        <style>
          body { font-family: system-ui, sans-serif; padding: 24px; color: #3D2B1F; }
          .grid { display: flex; flex-wrap: wrap; gap: 16px; }
          .label {
            border: 1px solid #E8D9CC; border-radius: 12px; background: #FEFAF3;
            padding: ${LABEL_PADDING}px; text-align: center; page-break-inside: avoid;
          }
          .title { font-weight: 700; font-size: 13px; margin-bottom: 2px; }
          .sub { font-size: 11px; color: #8B5E3C; margin-bottom: 8px; }
          .code { font-family: ui-monospace, monospace; font-size: 11px; color: #96755A; margin-top: 6px; }
          /* Never stretch the bars — the module width is already exact. */
          .bars svg { display: block; margin: 0 auto; }
          .skipped { margin-bottom: 16px; font-size: 12px; color: #B42318; }
          @page { size: auto; margin: 8mm; }
          @media print { .no-print { display: none; } }
        </style>
      </head>
      <body>
        <div class="no-print" style="margin-bottom:16px">
          <button onclick="window.print()" style="padding:8px 16px;border-radius:999px;border:1px solid #D99B3F;background:#E8B563;color:#3D2B1F;font-weight:600;font-size:14px;cursor:pointer">
            Print
          </button>
        </div>
        ${warning}
        <div class="grid">${cards.join("")}</div>
      </body>
    </html>
  `);
  win.document.close();
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
