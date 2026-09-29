"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CafeIllustration } from "@/components/CafeIllustration";
import { fmtDateTime } from "@/lib/format";

type Mode = "staff" | "admin";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("staff");
  const [username, setUsername] = useState("");
  const [staffCode, setStaffCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A disabled account gets a distinct panel instead of the generic sign-in
  // error, carrying the reason an admin recorded.
  const [deactivated, setDeactivated] = useState<{
    reason: string | null;
    when: string | null;
  } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDeactivated(null);
    setBusy(true);

    try {
      const url = mode === "admin" ? "/api/auth/login" : "/api/auth/staff";
      const body =
        mode === "admin" ? { username, password } : { token: staffCode, password };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.deactivated) {
          setDeactivated({
            reason: data.deactivation_reason ?? null,
            when: data.deactivated_at ?? null,
          });
        }
        throw new Error(data.error || "Sign in failed");
      }

      router.replace("/dashboard");
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-white">
      {/* ============ LEFT â€” peach panel ============ */}
      <div className="relative hidden w-[52%] shrink-0 overflow-hidden bg-cream-300 lg:block">
        <div className="relative z-10 flex h-full flex-col px-12 py-10">
          <h1 className="script-logo text-4xl">CafeTrack</h1>

          <div className="flex flex-1 items-center justify-center">
            <CafeIllustration className="w-full max-w-md" />
          </div>

          <p className="text-xs font-medium text-cocoa-600/70">
            Merrylane Cafe Foodhub Â· Lipa City
          </p>
        </div>

        {/* wavy right edge */}
        <svg
          className="absolute right-0 top-0 h-full w-16 text-white lg:w-24"
          viewBox="0 0 80 800"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            d="M0 0 C 58 110, 4 210, 44 330 C 76 430, 0 550, 40 670 C 58 730, 18 775, 0 800 L 0 0 Z"
            fill="currentColor"
          />
        </svg>
      </div>

      {/* ============ RIGHT â€” form ============ */}
      <div className="flex flex-1 items-center justify-center bg-white px-6 py-12">
        <div className="w-full max-w-[400px]">
          {/* mobile-only brand */}
          <div className="mb-6 text-center lg:hidden">
            <div className="script-logo-dark text-3xl">CafeTrack</div>
          </div>

          {/* double-framed card */}
          <div className="rounded-[32px] border border-cream-200 p-2">
            <div className="rounded-[24px] border border-cream-200 px-8 py-9">
              <div className="text-center">
                <div className="script-logo-dark text-2xl">CafeTrack</div>
                <h2 className="deco-title mt-0.5 text-5xl">Login</h2>
              </div>

              {/* mode switch */}
              <div className="mt-6 mb-5 grid grid-cols-2 gap-1 rounded-full bg-cream-100 p-1">
                {(["staff", "admin"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setMode(m);
                      setError(null);
                      setDeactivated(null);
                    }}
                    className={`rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                      mode === m
                        ? "bg-cream-400 text-cocoa-900 shadow-sm"
                        : "text-cocoa-400 hover:text-cocoa-600"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>

              <form onSubmit={submit} className="space-y-3.5">
                {mode === "admin" ? (
                  <input
                    className="input"
                    placeholder="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    required
                  />
                ) : (
                  <input
                    className="input font-mono"
                    placeholder="Staff barcode code"
                    value={staffCode}
                    onChange={(e) => setStaffCode(e.target.value)}
                    autoFocus
                    required
                  />
                )}

                <input
                  className="input"
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />

                {mode === "staff" && (
                  <p className="text-center text-[11px] text-cocoa-300">
                    Scan your staff ID, or type the code printed on it.
                  </p>
                )}

                {deactivated ? (
                  <div className="rounded-xl bg-ochre-50 px-3.5 py-3 text-center text-sm text-ochre-700">
                    <div className="font-bold">This account is deactivated</div>
                    {deactivated.reason && (
                      <div className="mt-1 text-xs leading-snug">
                        Reason: {deactivated.reason}
                      </div>
                    )}
                    {deactivated.when && (
                      <div className="mt-1 text-[11px] text-ochre-700">
                        Deactivated {fmtDateTime(deactivated.when)}
                      </div>
                    )}
                    <div className="mt-1.5 text-[11px] text-ochre-700">
                      Ask an administrator to re-activate it.
                    </div>
                  </div>
                ) : (
                  error && (
                    <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-center text-sm text-terracotta-700">
                      {error}
                    </div>
                  )
                )}

                <button
                  type="submit"
                  className="btn-primary w-full !py-2.5"
                  disabled={busy}
                >
                  {busy ? "Signing in..." : "Login"}
                </button>
              </form>
            </div>
          </div>

          <p className="mt-5 text-center text-[11px] text-cocoa-300">
            Sessions expire after a period of inactivity set by your administrator.
          </p>
        </div>
      </div>
    </div>
  );
}
