"use client";

import { useState } from "react";
import { api, ApiError, type LicenseStatus } from "../lib/api";
import { Card, Button } from "./ui";
import { useToast } from "./Toast";

const VENDOR_CONTACT = process.env.NEXT_PUBLIC_VENDOR_CONTACT ?? "your CLG Search account manager";

/**
 * Full-screen replacement for the entire dashboard whenever the license is
 * missing, expired, malformed, or bound to a different machine. Every page —
 * no exceptions — is unreachable until this resolves to a valid/grace status.
 */
export function LicenseLock({
  status,
  onActivated,
}: {
  status: LicenseStatus;
  onActivated: (next: LicenseStatus) => void;
}) {
  const [licenseKey, setLicenseKey] = useState("");
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const activate = async () => {
    if (!licenseKey.trim()) return;
    setActivating(true);
    setError("");
    try {
      const next = await api.post<LicenseStatus>("/license/activate", { licenseKey: licenseKey.trim() });
      onActivated(next);
      toast("License activated.", "success");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 dark:bg-ink-950">
      <Card className="w-full max-w-lg p-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">CS</div>
          <div className="text-base font-bold text-slate-900">CLG Search</div>
        </div>

        <h1 className="mt-6 text-lg font-semibold text-slate-900">This installation needs a valid license</h1>
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300">
          {status.state === "invalid" ? status.message : "A valid license is required to use this installation."}
        </p>

        {status.fingerprint && (
          <div className="mt-5">
            <div className="text-sm text-slate-500">Machine fingerprint</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code className="break-all rounded-lg bg-slate-100 px-3 py-1.5 font-mono text-xs text-slate-700 dark:bg-white/[0.06] dark:text-slate-200">
                {status.fingerprint}
              </code>
              <Button
                variant="secondary"
                onClick={() => {
                  navigator.clipboard?.writeText(status.fingerprint!);
                  toast("Copied to clipboard.", "success");
                }}
              >
                Copy
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-slate-500">Send this to your vendor to receive or transfer a license.</p>
          </div>
        )}

        <div className="mt-6 border-t border-slate-200 pt-5 dark:border-white/10">
          <div className="text-sm font-semibold text-slate-900">Have a license key?</div>
          <textarea
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            rows={5}
            placeholder={"-----BEGIN CLG SEARCH LICENSE-----\n…\n-----END CLG SEARCH LICENSE-----"}
            className="mt-2 w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 font-mono text-xs outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5"
          />
          {error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          <div className="mt-3">
            <Button onClick={activate} disabled={!licenseKey.trim()} loading={activating}>
              Activate
            </Button>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Need help? Contact <span className="font-medium text-slate-600 dark:text-slate-300">{VENDOR_CONTACT}</span>.
        </p>
      </Card>
    </div>
  );
}
