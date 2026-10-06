import Link from "next/link";
import { TableArt } from "@/components/BrandArt";

/**
 * Root 404. Unauthenticated visitors never reach it — the middleware sends
 * them to /login — so this is for a signed-in user following a stale link.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-cream-100 px-6">
      <div className="card max-w-md space-y-3 p-8 text-center">
        <TableArt className="mx-auto mb-2 max-w-[220px]" sizes="220px" />
        <div className="script-logo-dark text-3xl">CafeTrack</div>
        <div className="deco-title text-5xl">404</div>
        <p className="text-sm text-cocoa-500">
          That page does not exist. It may have been renamed, or the link that
          brought you here may be out of date.
        </p>
        <div className="flex justify-center gap-2 pt-1">
          <Link href="/login" className="btn-primary">
            Go to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
