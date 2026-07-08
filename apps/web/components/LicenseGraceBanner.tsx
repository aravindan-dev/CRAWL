"use client";

import { useState } from "react";
import type { LicenseStatus } from "../lib/api";

const DISMISS_KEY = "clg-license-banner-dismissed-for";

/** Persistent amber banner while the license is expired-but-in-grace, or
 *  approaching expiry. Dismissible for the current browser session only. */
export function LicenseGraceBanner({ status }: { status: LicenseStatus }) {
  const marker = status.state === "grace" ? "grace" : `soon-${status.expiresAt}`;
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && sessionStorage.getItem(DISMISS_KEY) === marker,
  );
  if (dismissed) return null;

  const message =
    status.state === "grace"
      ? `Your CLG Search license expired and is in its grace period (${status.graceDaysLeft} day(s) left). Contact your vendor to renew.`
      : `Your CLG Search license expires in ${status.daysLeft} day(s). Contact your vendor to renew.`;

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-800 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-200">
      <span>{message}</span>
      <button
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, marker);
          setDismissed(true);
        }}
        className="flex-none text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
