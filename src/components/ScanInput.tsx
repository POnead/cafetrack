"use client";

import { useEffect, useRef, useState } from "react";

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
  placeholder = "Scan or type code, then press Enter",
  disabled = false,
  autoFocus = true,
}: {
  onScan: (code: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [lastScanAt, setLastScanAt] = useState<number>(0);
  const ref = useRef<HTMLInputElement>(null);

  // Keep focus on the scan field unless the user is typing somewhere else.
  useEffect(() => {
    if (!autoFocus || disabled) return;

    const refocus = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el.isContentEditable) return;
      ref.current?.focus();
    };

    const t = setInterval(refocus, 800);
    return () => clearInterval(t);
  }, [autoFocus, disabled]);

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
        className="input pr-24 font-mono text-base"
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
        {lastScanAt > 0 && (
          <span className="text-[11px] text-emerald-600 font-medium">captured</span>
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
    </div>
  );
}
