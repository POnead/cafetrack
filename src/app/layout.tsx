import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

/*
 * Self-hosted so the app does not need Google Fonts at build or run time.
 *
 * These were `next/font/google` imports, which download the files during
 * compilation. On a machine without outbound access to fonts.googleapis.com
 * every page logged "Failed to download ... Using a fallback font instead" and
 * silently rendered Arial. The three `.woff2` files beside this file are the
 * latin subsets of the same families, committed once, so no build depends on a
 * third party being reachable.
 */
const pacifico = localFont({
  src: "./fonts/pacifico-latin.woff2",
  weight: "400",
  style: "normal",
  variable: "--font-pacifico",
  display: "swap",
});

const baloo = localFont({
  src: "./fonts/baloo-2-latin.woff2",
  weight: "400 800",
  style: "normal",
  variable: "--font-baloo",
  display: "swap",
});

const nunito = localFont({
  src: "./fonts/nunito-latin.woff2",
  weight: "200 1000",
  style: "normal",
  variable: "--font-nunito",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CafeTrack — Cafe Inventory Management",
  description: "CafeTrack inventory operations for cafe teams",
};

/*
 * Every page in this app is dynamic.
 *
 * The proxy stamps a per-request CSP nonce into Next's inline bootstrap
 * scripts (next.config.mjs deliberately keeps the policy in proxy.ts). A
 * page prerendered at build time cannot carry a per-request nonce — its
 * scripts are stamped at build time, or not at all — so the browser refuses
 * to run any of them and the page ships a shell of dead controls. /login was
 * prerendered and its sign-in form never hydrated: fully rendered, entirely
 * unusable. A dynamic render stamps the nonce at request time and the scripts
 * run. The (app) layout reached the same conclusion for the same reason;
 * this makes it the rule for every route, including /login, /verify and
 * /_not-found. On a LAN install the cost of a server render is nothing.
 *
 * CAFETRACK_CSP_LEGACY=1 remains the escape hatch for a deployment that must
 * keep a browser alive without nonce support.
 */
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${pacifico.variable} ${baloo.variable} ${nunito.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
          Suppress the browser's own password-reveal button.

          Edge draws one inside every password field as soon as you type or focus
          it, and drops it again when you look away. Beside the login form's own
          reveal — which is always there, by choice — it reads as a second control
          blinking in and out on its own. `::-ms-reveal` is the handle Microsoft
          documents for exactly this.

          This lives here, inline, rather than in globals.css because the CSS
          pipeline runs Tailwind's parser over the stylesheet and silently drops
          selectors built from pseudo-elements it does not recognise. `::-ms-reveal`
          is Edge-only, so the rule never reached the browser — the comment in
          globals.css survived, the selector did not. Verified in the served CSS,
          not just on disk. An inline <style> is not routed through PostCSS.
        */}
        <style>{`
          input[type="password"]::-ms-reveal,
          input[type="password"]::-ms-clear {
            display: none !important;
          }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
