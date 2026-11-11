import Image from "next/image";
import { CupMark } from "@/components/icons";

export function CafeTrackBrand({
  onDark = false,
  compact = false,
  large = false,
}: {
  onDark?: boolean;
  compact?: boolean;
  large?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 flex-col items-start gap-1">
      <Image
        src={
          onDark
            ? "/brand/merrylane-wordmark-light.png"
            : "/brand/merrylane-wordmark-dark.png"
        }
        alt="Merrylane Cafe"
        width={onDark ? 406 : 413}
        height={onDark ? 158 : 164}
        sizes={compact ? "112px" : large ? "224px" : "176px"}
        unoptimized
        loading="eager"
        className={`h-auto object-contain ${
          compact ? "w-28 max-[360px]:w-20" : large ? "w-56" : "w-44"
        }`}
      />
      <span
        className={`inline-flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.14em] ${
          onDark ? "text-cream-300/70" : "text-cocoa-500"
        } ${compact ? "text-[8px] max-[360px]:hidden" : ""}`}
      >
        <CupMark className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden="true" />
        CafeTrack Inventory System
      </span>
    </span>
  );
}
