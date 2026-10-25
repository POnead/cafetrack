import type { Metadata } from "next";
import { Pacifico, Baloo_2, Nunito } from "next/font/google";
import "./globals.css";

const pacifico = Pacifico({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-pacifico",
  display: "swap",
});

const baloo = Baloo_2({
  subsets: ["latin"],
  variable: "--font-baloo",
  display: "swap",
});

const nunito = Nunito({
  subsets: ["latin"],
  variable: "--font-nunito",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CafeTrack — Merrylane Cafe Foodhub",
  description: "Real-time stock monitoring with barcode-based authentication",
};

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
