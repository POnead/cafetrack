import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /* CafeTrack warm palette */
        cream: {
          50: "#FEFAF3",
          100: "#FDF3E3",
          200: "#F8E6C8",
          300: "#F5D5A8", // main peach panel
          400: "#F0C582",
          500: "#E8B563", // primary button
          600: "#D99B3F",
          700: "#B87A28",
        },
        cocoa: {
          50: "#F5EFE9",
          100: "#E8D9CC",
          200: "#D3BCA6",
          300: "#B08B6B",
          400: "#96755A",
          500: "#8B5E3C",
          600: "#6E4526",
          700: "#5E3A1F", // sidebar
          800: "#4A2D17",
          900: "#3D2B1F", // body text
        },
        /* Warm status tones — sit next to the cream/cocoa scale.
           Used by the status/type/stock tags (see Badge `variant="tag"`). */
        sage: {
          50: "#EEF3E9",
          100: "#DCE7D2",
          500: "#6B8F5A",
          700: "#4A6638",
        },
        ochre: {
          50: "#FAF0DC",
          100: "#F3E0BB",
          500: "#B8862F",
          700: "#8A611A",
        },
        terracotta: {
          50: "#F7E4DF",
          100: "#EFCFC7",
          500: "#B5603E",
          700: "#8A3423",
        },
        rust: {
          50: "#EDD5CE",
          100: "#E0BAB0",
          500: "#8B3A24",
          700: "#5E2318",
        },
        /* Kept so existing pages keep working after the palette swap */
        brand: {
          50: "#FDF3E3",
          100: "#F8E6C8",
          200: "#F5D5A8",
          500: "#E8B563",
          600: "#D99B3F",
          700: "#B87A28",
        },
      },
      fontFamily: {
        script: ["var(--font-pacifico)", "cursive"],
        deco: ["var(--font-baloo)", "system-ui", "sans-serif"],
        sans: ["var(--font-nunito)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        warm: "0 2px 12px rgba(93, 58, 31, 0.06)",
        "warm-lg": "0 8px 28px rgba(93, 58, 31, 0.12)",
      },
    },
  },
  plugins: [],
};

export default config;
