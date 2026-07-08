"use client";

import { useState } from "react";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { api, ApiError, type LicenseStatus } from "../../lib/api";
import { Card, Button, Badge } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";

const VENDOR_CONTACT = process.env.NEXT_PUBLIC_VENDOR_CONTACT ?? "your CLG Search account manager";

function daysLabel(status: LicenseStatus): string {
  if (status.state === "valid" && status.daysLeft !== undefined) return `${status.daysLeft} day(s) left`;
  if (status.state === "grace" && status.graceDaysLeft !== undefined) return `expired — ${status.graceDaysLeft} day(s) grace left`;
  return "";
}

function CopyButton({ value }: { value: string }) {
  const toast = useToast();
  return (
    <Button
      variant="secondary"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        toast("Copied to clipboard.", "success");
      }}
    >
      Copy
    </Button>
  );
}

export default function LicensePage() {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  useAutoRefresh(() => api.get<LicenseStatus>("/license/status").then(setStatus).catch(() => {}), 30000);

  const activate = async () => {
    if (!licenseKey.trim()) return;
    setActivating(true);
    setError("");
    try {
      const next = await api.post<LicenseStatus>("/license/activate", { licenseKey: licenseKey.trim() });
      setStatus(next);
      setLicenseKey("");
      toast("License activated.", "success");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Advanced" title="License" subtitle="Activation status for this server, and where to send your vendor if anything needs attention." />

      {status && (
        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm text-slate-500">Status</div>
              <div className="mt-1 flex items-center gap-2">
                <Badge value={status.state === "valid" ? "OK" : status.state === "grace" ? "WARN" : "ERROR"} />
                <span className="text-sm text-slate-600">{daysLabel(status)}</span>
              </div>
            </div>
            {status.customerName && (
              <div className="text-right text-sm text-slate-600">
                Licensed to <span className="font-semibold text-slate-900">{status.customerName}</span>
                {status.edition && <span className="text-slate-400"> · {status.edition}</span>}
              </div>
            )}
          </div>

          {status.state === "invalid" && (
            <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300">
              {status.message}
            </p>
          )}

          <dl className="mt-5 grid grid-cols-1 gap-4 border-t border-slate-200 pt-5 text-sm sm:grid-cols-2 dark:border-white/10">
            {status.expiresAt && (
              <div>
                <dt className="text-slate-500">Expires</dt>
                <dd className="mt-0.5 font-medium text-slate-900">{new Date(status.expiresAt).toLocaleDateString()}</dd>
              </div>
            )}
            <div>
              <dt className="text-slate-500">Universities allowed</dt>
              <dd className="mt-0.5 font-medium text-slate-900">{status.maxUniversities ?? "Unlimited"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Users allowed</dt>
              <dd className="mt-0.5 font-medium text-slate-900">{status.maxUsers ?? "Unlimited"}</dd>
            </div>
            {status.licenseId && (
              <div>
                <dt className="text-slate-500">License ID</dt>
                <dd className="mt-0.5 break-all font-mono text-xs text-slate-700">{status.licenseId}</dd>
              </div>
            )}
          </dl>

          {status.fingerprint && (
            <div className="mt-5 border-t border-slate-200 pt-5 dark:border-white/10">
              <div className="text-sm text-slate-500">Machine fingerprint</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <code className="break-all rounded-lg bg-slate-100 px-3 py-1.5 font-mono text-xs text-slate-700 dark:bg-white/[0.06] dark:text-slate-200">
                  {status.fingerprint}
                </code>
                <CopyButton value={status.fingerprint} />
              </div>
              <p className="mt-1.5 text-xs text-slate-500">Send this to your vendor to receive or transfer a license bound to this machine.</p>
            </div>
          )}
        </Card>
      )}

      <Card className="p-6">
        <h2 className="text-sm font-semibold text-slate-900">Activate a license</h2>
        <p className="mt-1 text-sm text-slate-500">Paste the license key your vendor sent you (including the BEGIN/END lines).</p>
        <textarea
          value={licenseKey}
          onChange={(e) => setLicenseKey(e.target.value)}
          rows={6}
          placeholder={"-----BEGIN CLG SEARCH LICENSE-----\n…\n-----END CLG SEARCH LICENSE-----"}
          className="mt-3 w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 font-mono text-xs outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5"
        />
        {error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="mt-3">
          <Button onClick={activate} disabled={!licenseKey.trim()} loading={activating}>
            Activate
          </Button>
        </div>
      </Card>

      <Card className="p-6 text-sm text-slate-500">
        Need help with licensing? Contact <span className="font-medium text-slate-700 dark:text-slate-300">{VENDOR_CONTACT}</span>.
      </Card>
    </div>
  );
}
