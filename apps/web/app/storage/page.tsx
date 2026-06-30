"use client";

import { useCallback, useState } from "react";
import { api } from "../../lib/api";
import { Card, Button, StatCard } from "../../components/ui";
import { ConfirmButton } from "../../components/Confirm";
import { PageHeader } from "../../components/PageHeader";
import { Reveal, Stagger, Item } from "../../components/motion";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { useToast } from "../../components/Toast";

type Target = "screenshots" | "html" | "text" | "exports" | "backups";
interface Usage {
  areas: { key: Target; bytes: number; human: string }[];
  totalBytes: number;
  totalHuman: string;
  db: { links: number; snapshots: number; criteria: number };
}

const LABEL: Record<Target, { name: string; note: string; color: string }> = {
  screenshots: { name: "Page screenshots", note: "One image per crawled page (usually the biggest)", color: "bg-brand-500" },
  html: { name: "Cached page HTML", note: "Raw HTML of parseable pages", color: "bg-violet-500" },
  text: { name: "Extracted text", note: "Cleaned text + section chunks for parsing", color: "bg-emerald-500" },
  exports: { name: "Export files", note: "Excel/CSV deliverables — download before clearing", color: "bg-amber-500" },
  backups: { name: "Backups", note: "University-list snapshots (safety net)", color: "bg-slate-400" },
};
// Areas the user can safely reclaim from here (backups are kept as a safety net).
const CLEARABLE: Target[] = ["screenshots", "html", "text", "exports"];

export default function StoragePage() {
  const toast = useToast();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sel, setSel] = useState<Set<Target>>(new Set(["screenshots"]));
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setUsage(await api.get<Usage>("/ops/storage")); } catch { /* api down */ }
  }, []);
  useAutoRefresh(load, 8000);

  const toggle = (t: Target) => setSel((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });

  const cleanup = async () => {
    const targets = [...sel];
    if (targets.length === 0) { toast("Pick at least one area to clear.", "info"); return; }
    setBusy(true);
    try {
      const r = await api.post<{ freedHuman: string; cleared: Target[] }>("/ops/storage/cleanup", { targets });
      toast(`Freed ${r.freedHuman} (${r.cleared.map((c) => LABEL[c].name.toLowerCase()).join(", ")}).`, "success");
      await load();
    } catch (e) { toast(String(e), "error"); } finally { setBusy(false); }
  };

  const clearCrawlData = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ links: number; snapshots: number; criteria: number; freedHuman: string }>("/ops/storage/clear-crawl-data");
      toast(`Cleared ${r.links} links · ${r.snapshots} snapshots · ${r.criteria} criteria. Freed ${r.freedHuman}. Universities kept.`, "success");
      await load();
    } catch (e) { toast(String(e), "error"); } finally { setBusy(false); }
  };

  const areaByKey = (k: Target) => usage?.areas.find((a) => a.key === k);
  const maxBytes = usage ? Math.max(1, ...usage.areas.map((a) => a.bytes)) : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Maintenance · Disk space"
        title="Storage"
        subtitle={<>Crawls accumulate a lot of data — a screenshot per page, cached HTML/text, and exports. <b>After you&rsquo;ve exported and downloaded what you need</b>, reclaim that space here. Your universities list and backups are never touched.</>}
        actions={<Button variant="secondary" onClick={load} disabled={busy}>Refresh</Button>}
      />

      <Stagger className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Item><StatCard label="Total on disk" value={usage ? usage.totalHuman : "—"} accent="text-brand-600" /></Item>
        <Item><StatCard label="Discovered links" value={usage ? usage.db.links.toLocaleString() : "—"} /></Item>
        <Item><StatCard label="Page snapshots" value={usage ? usage.db.snapshots.toLocaleString() : "—"} /></Item>
        <Item><StatCard label="Parsed criteria" value={usage ? usage.db.criteria.toLocaleString() : "—"} /></Item>
      </Stagger>

      <Reveal>
        <Card className="p-5">
          <div className="mb-4 font-semibold text-slate-900">By area</div>
          <div className="space-y-3">
            {(Object.keys(LABEL) as Target[]).map((k) => {
              const a = areaByKey(k);
              const clearable = CLEARABLE.includes(k);
              const checked = sel.has(k);
              return (
                <div key={k} className="flex items-center gap-3">
                  <label className={`flex w-56 flex-none items-center gap-2.5 ${clearable ? "cursor-pointer" : "opacity-70"}`}>
                    <input type="checkbox" disabled={!clearable} checked={checked} onChange={() => toggle(k)}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400" />
                    <span>
                      <span className="block text-sm font-medium text-slate-800">{LABEL[k].name}</span>
                      <span className="block text-[11px] leading-tight text-slate-400">{LABEL[k].note}</span>
                    </span>
                  </label>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
                    <div className={`h-full rounded-full ${LABEL[k].color} transition-all`} style={{ width: `${a ? (a.bytes / maxBytes) * 100 : 0}%` }} />
                  </div>
                  <span className="tnum w-20 flex-none text-right text-sm text-slate-600">{a ? a.human : "—"}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4 dark:border-white/10">
            <Button onClick={cleanup} disabled={busy || sel.size === 0}>{busy ? "Working…" : `Delete selected (${sel.size})`}</Button>
            <span className="text-xs text-slate-400">Deletes the files for the ticked areas and updates the database so the UI won&rsquo;t look for missing files. Links &amp; criteria stay.</span>
          </div>
        </Card>
      </Reveal>

      <Reveal>
        <Card className="border-rose-100 p-5 dark:border-rose-500/20">
          <div className="font-semibold text-slate-900">Clear all crawl data</div>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Removes <b>all discovered links, page snapshots, parsed criteria, logs and artifacts</b> and resets every university to
            <b> IDLE</b> — but <b>keeps your universities list and validated exports</b>. Use this when an export is finished and you
            want a clean slate to re-crawl without re-adding universities. This cannot be undone.
          </p>
          <div className="mt-4">
            <ConfirmButton label="Clear all crawl data" variant="danger"
              title="Clear all crawl data?"
              message="Deletes every discovered link, snapshot, parsed criterion, log and on-disk artifact, and resets universities to IDLE. Your universities list and validated exports are kept. This cannot be undone."
              confirmPhrase="CLEAR" confirmLabel="Clear crawl data" onConfirm={clearCrawlData} />
          </div>
        </Card>
      </Reveal>
    </div>
  );
}
