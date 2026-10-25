"use client";

import { useState, useRef } from "react";

import { useScanFocus } from "@/lib/use-scan-focus";

/**
 * Keyboard-wedge scanner input.
 *
 * USB barcode scanners behave like a keyboard: they type the code very fast
 * and end with Enter. This component keeps itself focused so a scan lands here
 * without the user clicking anything. Typing manually works exactly the same,
 * which is also the fallback for a damaged or unreadable label.
 */
export function ScanInput({
  onScan,
  onChange,
  placeholder = "Scan or type code, then press Enter",
  label = "Barcode scanner",
  disabled = false,
  autoFocus = true,
}: {
  onScan: (code: string) => void;
  /**
   * Fires on every keystroke so the parent's state stays in sync with what the
   * user has typed. Without this, typing into the field and then clicking a
   * submit button elsewhere on the form sends an empty string — the parent never
   * saw the value because onScan only fires on Enter/Add.
   */
  onChange?: (value: string) => void;
  placeholder?: string;
  /**
   * The accessible name. A placeholder disappears as soon as anything is typed
   * and is not reliably announced, so the field would otherwise be announced as
   * an unnamed text box — which is the one control on the till that a person
   * using a screen reader most needs named.
   */
  label?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [lastScanAt, setLastScanAt] = useState<number>(0);
  const ref = useRef<HTMLInputElement>(null);

  // Shared with the inline search field on the checkout page, which lost this
  // behaviour once when it stopped being built from this component. See
  // src/lib/use-scan-focus.ts.
  useScanFocus(ref, autoFocus && !disabled);

  const submit = () => {
    const code = value.trim();
    if (!code) return;
    onScan(code);
    setValue("");
    setLastScanAt(Date.now());
  };

  return (
    <div className="relative">
      <input
        ref={ref}
        aria-label={label}
        className="input font-mono text-base sm:pr-24"
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        inputMode="text"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          onChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      {/* Absolutely positioned beside the field on sm+, which is where there is
          room for it. Below that the padding would eat most of a narrow input,
          so the button becomes a normal flow item underneath instead. */}
      <div className="absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-2 sm:flex">
        {lastScanAt > 0 && (
          <span className="text-[11px] font-medium text-sage-700">captured</span>
        )}
        <button
          type="button"
          className="btn-ghost !px-2.5 !py-1 text-xs"
          onClick={submit}
          disabled={disabled}
        >
          Add
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2 sm:hidden">
        {lastScanAt > 0 && (
          <span className="text-[11px] font-medium text-sage-700">captured</span>
        )}
        <button
          type="button"
          className="btn-ghost !py-1.5 flex-1 text-sm"
          onClick={submit}
          disabled={disabled}
        >
          Add item
        </button>
      </div>
    </div>
  );
}
