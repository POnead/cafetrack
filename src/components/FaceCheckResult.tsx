type Props = {
  status: "checking" | "passed" | "failed";
  title: string;
  message: string;
};

export function FaceCheckResult({ status, title, message }: Props) {
  const passed = status === "passed";
  const failed = status === "failed";

  return (
    <section
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      aria-busy={status === "checking"}
      className={`flex flex-col items-center gap-3 rounded-xl border px-4 py-5 text-center ${
        passed
          ? "border-sage-200 bg-sage-50 text-sage-800"
          : failed
            ? "border-terracotta-200 bg-terracotta-50 text-terracotta-800"
            : "border-cream-200 bg-cream-50 text-cocoa-700"
      }`}
    >
      <div
        className={`flex h-14 w-14 items-center justify-center rounded-full ${
          passed
            ? "face-result-pop bg-sage-100 text-sage-700"
            : failed
              ? "face-result-pop bg-terracotta-100 text-terracotta-700"
              : "bg-cream-200 text-cocoa-500"
        }`}
        aria-hidden="true"
      >
        {status === "checking" ? (
          <span className="h-7 w-7 animate-spin rounded-full border-[3px] border-cream-400 border-t-cocoa-600" />
        ) : (
          <svg
            className="h-7 w-7"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {passed ? (
              <path className="face-result-draw" d="m4 12 5 5L20 6" />
            ) : (
              <path className="face-result-draw" d="m6 6 12 12M18 6 6 18" />
            )}
          </svg>
        )}
      </div>
      <div>
        <h3 className="font-bold">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed opacity-80">{message}</p>
      </div>
    </section>
  );
}
