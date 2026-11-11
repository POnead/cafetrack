import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

function lanIPv4() {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter(
      (entry) =>
        !entry.internal &&
        (entry.family === "IPv4" || entry.family === 4) &&
        !entry.address.startsWith("169.254.")
    )
    .map((entry) => entry.address);
  const priority = (address) => {
    const [first, second] = address.split(".").map(Number);
    if (first === 192 && second === 168) return 0;
    if (first === 10) return 1;
    if (first === 172 && second >= 16 && second <= 31) return 2;
    return 3;
  };
  return addresses.sort((a, b) => priority(a) - priority(b))[0];
}

const host = process.env.CAFETRACK_DEV_HOST?.trim() || process.env.DEV_HOST?.trim() || lanIPv4() || "0.0.0.0";
const port = process.env.PORT || "3100";
const args = [
  resolve("node_modules/next/dist/bin/next"),
  "dev",
  "--hostname",
  host,
  "--port",
  port,
  "--experimental-https",
];

const address = host ?? "localhost";
console.log(`[cafetrack] HTTPS development address: https://${address}:${port}`);
if (host) {
  console.log(
    "[cafetrack] On a phone, trust the development CA certificate shown by Next.js before opening the camera."
  );
}

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    CAFETRACK_DEV_HTTPS: "1",
    CAFETRACK_DEV_HOST: address,
  },
});

child.on("error", (error) => {
  console.error("[cafetrack] Could not start the HTTPS development server:", error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
