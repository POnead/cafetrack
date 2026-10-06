import Image from "next/image";

/**
 * The cafe illustrations, served from `public/brand`.
 *
 * These are the only raster assets in the app. Everything else stays inline SVG
 * so it remains sharp at any size and themeable, and `CupMark` in ./icons is
 * still a vector because it has to work at 20px in the sidebar.
 *
 * Two things about the source files are worth knowing before moving them
 * around. They are 500x500 JPEGs, and the white in them is opaque rather than
 * transparent.
 *
 * The white is handled by placing an illustration on a white surface, where its
 * own background is invisible. `mix-blend-multiply` looks like the obvious fix
 * and is not used on purpose: blending only reaches the backdrop of the nearest
 * isolated group, and the login panel's content column sets `z-10`, so the
 * blend would quietly do nothing and leave a white square on the peach.
 *
 * Sizing is done with the intrinsic `width`/`height` instead of `fill` so that
 * `h-auto w-full` in `className` drives the layout without fighting an
 * absolutely positioned fill.
 *
 * `sizes` is not optional in practice. Left off, Next assumes the image is as
 * wide as the viewport and emits a `640w 1x, 1080w 2x` srcset, which against a
 * 500px source means every browser downloads an upscaled image to fill a slot a
 * few hundred pixels across. Pass the width the image actually renders at.
 * Declaring it slightly wide is harmless and erring narrow is what makes art
 * look blurry, so round up rather than trying to be exact.
 *
 * Keep that width at or below ~400px. The source is 500px, so that is 1:1 on a
 * standard display and slightly soft on a 2x one; these read as deliberate line
 * art, not as a soft photo.
 */

/**
 * @param alt Leave empty (the default) for decorative art. Every illustration
 *   here sits next to a "CafeTrack" wordmark or a heading that already names
 *   the cafe, so a description would only repeat it to a screen reader.
 */
type BrandArtProps = {
  className?: string;
  alt?: string;
  /** Above-the-fold art only. Preloads via a `<link>` in the head. */
  preload?: boolean;
  /** The width the image actually renders at, in CSS px. */
  sizes?: string;
};

function BrandArt({
  src,
  alt = "",
  className = "",
  preload = false,
  sizes = "380px",
}: BrandArtProps & { src: string }) {
  return (
    <Image
      src={src}
      alt={alt}
      width={500}
      height={500}
      sizes={sizes}
      preload={preload}
      className={`h-auto w-full ${className}`}
    />
  );
}

/** Isometric coffee shop with a striped awning — the login hero. */
export function StorefrontArt(props: BrandArtProps) {
  return <BrandArt src="/brand/storefront.jpg" {...props} />;
}

/** Barista handing a drink to a customer across the counter — the dashboard. */
export function BaristaArt(props: BrandArtProps) {
  return <BrandArt src="/brand/barista.jpg" {...props} />;
}

/** Two customers talking over coffee at a table — the 404. */
export function TableArt(props: BrandArtProps) {
  return <BrandArt src="/brand/table.jpg" {...props} />;
}
