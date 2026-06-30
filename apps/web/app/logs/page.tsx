"use client";

import { useEffect, useState } from "react";
import { api, type Page, type CrawlLog } from "../../lib/api";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { Card, Badge } from "../../components/ui";
import { ConfirmButton } from "../../components/Confirm";
import { PageHeader } from "../../components/PageHeader";
import { Reveal } from "../../components/motion";

const selectCls = "rounded-lg border border-slate-300 bg-white/60 px-3 py-1.5 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5";

export default function LogsPage() {
  const [items, setItems] = useState<CrawlLog[]>([]);
  const [action, setAction] = useState("");
  const [status, setStatus] = useState("");

  async function load() {
    const params = new URLSearchParams({ take: "100" });
    if (action) params.set("action", action);
    if (status) params.set("status", status);
    const page = await api.get<Page<CrawlLog>>(`/logs?${params.toString()}`);
    setItems(page.items);
  }
  useEffect(() => { void load(); }, [action, status]);
  useAutoRefresh(load, 5000); // live logs + reflects actions from other pages

  return (
    <div>
      <PageHeader
        eyebrow="Data · Observability"
        title="Logs"
        subtitle="Per-stage pipeline observability."
        actions={
          <div className="flex flex-wrap gap-2">
            <select value={action} onChange={(e) => setAction(e.target.value)} className={selectCls}>
              {["", "DISCOVER_LINKS", "VALIDATE_LINK", "EXTRACT_PAGE", "CHUNK_CONTENT", "PARSE_CRITERIA", "STORE_CRITERIA"].map((a) => <option key={a} value={a}>{a || "All actions"}</option>)}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectCls}>
              {["", "OK", "WARN", "ERROR"].map((s) => <option key={s} value={s}>{s || "All"}</option>)}
            </select>
            <ConfirmButton
              label="Clear logs"
              title="Clear all activity logs?"
              message="Deletes every log entry. Crawl data, links and exports are NOT affected. This cannot be undone."
              confirmLabel="Clear logs"
              onConfirm={async () => { await api.post("/ops/maintenance/clear-logs"); await load(); }}
            />
          </div>
        }
      />

      <Reveal>
        <Card className="mt-5 overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/60 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-white/5">
              <tr><th className="px-4 py-3">Time</th><th className="px-4 py-3">Action</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Message</th><th className="px-4 py-3">ms</th></tr>
            </thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">No logs.</td></tr>}
              {items.map((l) => (
                <tr key={l.id} className="border-b border-slate-100 align-top transition-colors last:border-0 hover:bg-slate-50/50 dark:border-white/5 dark:hover:bg-white/5">
                  <td className="tnum whitespace-nowrap px-4 py-3 text-xs text-slate-500">{new Date(l.created_at).toLocaleTimeString()}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{l.action}</td>
                  <td className="px-4 py-3"><Badge value={l.status} /></td>
                  <td className="px-4 py-3 text-slate-700">
                    {l.message}
                    {l.error_stack && <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-rose-50 p-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{l.error_stack}</pre>}
                  </td>
                  <td className="tnum px-4 py-3 font-mono text-xs text-slate-500">{l.duration_ms ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      </Reveal>
    </div>
  );
}
