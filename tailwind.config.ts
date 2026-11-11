import type { Config } from "tailwindcss";

const config: Config = {
  /*
   * Only the two directories that can contain a class name.
   *
   * This used to be `./src/**` + `.{ts,tsx}`, which swept in every file under
   * src/lib — thirty-odd modules that hold no markup and not one class string
   * between them. Two costs, and the second is the one that bit us:
   *
   *   - tailwind parses them on every rebuild, for nothing;
   *   - each one becomes a watched content path, and the watcher stats that list
   *     whenever anything changes. Add, rename or delete a file while the dev
   *     server is running and it can stat a path that has just stopped existing
   *     and throw ENOENT from resolveChangedContent — which surfaces as
   *     "Error evaluating Node.js code" against globals.css, killing every page
   *     with a 500 and naming a file that has nothing to do with styling.
   *
   * Keeping the list to where classes actually live makes that window much
   * smaller. If a class ever needs to be composed in a lib module, put it in
   * src/components instead — that is where Tailwind is looking.
   */
  content: ["./src/app/**/*.{ts,tsx}", "./src/components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /* CafeTrack warm palette */
        cream: {
          50: "#FFFCF7",
          100: "#F6F1E8",
          200: "#EEE6D9",
          300: "#EADBC8",
          400: "#C8A274",
          500: "#BD8C53",
          600: "#A67642",
          700: "#70482D",
        },
        cocoa: {
          50: "#F6F1E8",
          100: "#EEE6D9",
          200: "#E7DDCF",
          300: "#A5978A",
          400: "#8A7B6D",
          500: "#8D6040",
          600: "#70482D",
          700: "#38261C",
          800: "#4B3A2E",
          900: "#2C211A",
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
          50: "#FFFCF7",
          100: "#F6F1E8",
          200: "#EEE6D9",
          500: "#BD8C53",
          600: "#A67642",
          700: "#70482D",
        },
      },
      fontFamily: {
        script: ["var(--font-pacifico)", "cursive"],
        deco: ["var(--font-baloo)", "system-ui", "sans-serif"],
        sans: ["var(--font-nunito)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        warm: "0 2px 6px rgba(47, 32, 22, 0.05), 0 10px 24px rgba(47, 32, 22, 0.06)",
        "warm-lg": "0 18px 50px rgba(47, 32, 22, 0.09)",
      },
    },
  },
  plugins: [],
};

export default config;
