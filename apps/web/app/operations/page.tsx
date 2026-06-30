"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The old "Operations" page has been split into the streamlined flow:
 *   • Validate / de-dup / drop-404 → /revalidate
 *   • Build Aliff inputs + Aliff auto-fill + downloads → /export
 * This route now redirects to Export & Aliff so old links keep working.
 */
export default function OperationsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/export");
  }, [router]);
  return (
    <div className="py-20 text-center text-sm text-slate-500">
      Operations moved — taking you to <a href="/export" className="text-brand-600 hover:underline">Export &amp; Aliff</a>…
    </div>
  );
}
