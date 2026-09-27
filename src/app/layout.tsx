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
    >
      <body>{children}</body>
    </html>
  );
}
