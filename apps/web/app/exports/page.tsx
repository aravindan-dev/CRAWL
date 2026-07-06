"use client";

import { useState } from "react";
import { api, API_URL } from "../../lib/api";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { Card, StatCard, Button } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { Reveal, Stagger, Item } from "../../components/motion";

interface FileRow { name: string; size: number; url: string; group: string; mtime: number }
interface Counts { universityUrls: number; courseUrls: number; totalUrls: number; generatedAt: string | null }

type Tag = "University" | "Course" | "Scholarship" | "All";
const TAG_CLS: Record<Tag, string> = {
  University: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
  Course: "bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300",
  Scholarship: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  All: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
};

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
/** Local date + time, e.g. "2 Jul 2026, 12:05". */
const when = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

/**
 * A clean, human-readable title for a deliverable file (keeps the real filename for
 * download). Turns "Charles-Sturt-University__2026-07-02_1205.csv" into
 * "Charles Sturt University", and the fixed pipeline files into plain-English names.
 */
function prettyFile(name: string): { title: string; tag: Tag } {
  const base = name.replace(/\.(csv|xlsx)$/i, "");
  if (/^eligibility-ALL-INTERNATIONAL/i.test(base)) return { title: "All universities — complete export", tag: "All" };
  if (/^eligibility-UNIVERSITY-INTERNATIONAL-FINAL/i.test(base)) return { title: "University eligibility URLs — final", tag: "University" };
  if (/^eligibility-COURSES-INTERNATIONAL-FINAL/i.test(base)) return { title: "Course eligibility URLs — final", tag: "Course" };
  if (/^scholarships-INTERNATIONAL-FINAL/i.test(base)) return { title: "Scholarship URLs — final", tag: "Scholarship" };
  if (/^aliff-input-universit/i.test(base)) return { title: "Aliff input — universities", tag: "University" };
  if (/^aliff-input-course/i.test(base)) return { title: "Aliff input — courses", tag: "Course" };
  // Per-university file: "<University Name>__<stamp>"
  const uni = base.split("__")[0]?.replace(/[-_]+/g, " ").trim();
  return { title: uni || base, tag: /scholarship/i.test(base) ? "Scholarship" : "University" };
}

export default function ExportsPage() {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);

  const load = () => {
    api.get<{ files: FileRow[] }>("/ops/files").then((r) => setFiles(r.files)).catch(() => {});
    api.get<Counts>("/ops/export-counts").then(setCounts).catch(() => {});
  };
  useAutoRefresh(load, 5000);

  const groups = [...new Set(files.map((f) => f.group))];
  // When the deliverables were last written = the newest file. This is effectively
  // "crawl finished & the CSV/Excel were created" for the whole batch.
  const lastCreated = files.length ? Math.max(...files.map((f) => f.mtime || 0)) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workflow · Deliverables"
        title="Exports & downloads"
        subtitle="Your validated eligibility / criteria URLs — university and course, ready to download."
        actions={<Button variant="secondary" onClick={load}>Refresh</Button>}
      />

      {/* Totals */}
      <Stagger className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Item><StatCard label="University URLs" value={counts ? counts.universityUrls.toLocaleString() : "—"} accent="text-brand-600" icon={<svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 9.5 12 4l9 5.5" /><path d="M5 10v8h14v-8" /></svg>} /></Item>
        <Item><StatCard label="Course URLs" value={counts ? counts.courseUrls.toLocaleString() : "—"} accent="text-brand-600" icon={<svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 19V5a2 2 0 0 1 2-2h10l4 4v12" /><path d="M8 7h6M8 11h8" /></svg>} /></Item>
        <Item><StatCard label="Total URLs" value={counts ? counts.totalUrls.toLocaleString() : "—"} accent="text-emerald-600" icon={<svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 12h18M3 6h18M3 18h18" /></svg>} /></Item>
        <Item><StatCard label="Files created" value={when(lastCreated)} icon={<svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>} /></Item>
      </Stagger>

      {/* Crawl-finished / generation banner */}
      {lastCreated && (
        <Reveal>
          <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
            <span className="flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200">
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              </span>
              Crawl finished &amp; files created
            </span>
            <span className="text-slate-600 dark:text-slate-300">CSV + Excel written <b>{when(lastCreated)}</b> <span className="text-slate-400">(your local time)</span></span>
            <span className="text-xs text-slate-400">Each file below also shows exactly when it was created.</span>
          </Card>
        </Reveal>
      )}

      {files.length === 0 ? (
        <Reveal>
          <Card className="p-6 text-center text-sm text-slate-500">
            No exports yet. Go to <a href="/revalidate" className="text-brand-600 hover:underline">Revalidate</a> to generate them.
          </Card>
        </Reveal>
      ) : (
        groups.map((g) => (
          <Reveal key={g}>
            <Card className="p-5">
              <div className="mb-3 font-semibold text-slate-900">{g}</div>
              <div className="space-y-2">
                {files.filter((f) => f.group === g).map((f) => {
                  const { title, tag } = prettyFile(f.name);
                  const isExcel = f.name.toLowerCase().endsWith(".xlsx");
                  return (
                    <div key={f.name} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-4 py-3 transition-colors hover:bg-slate-50/60 dark:border-white/10 dark:hover:bg-white/5">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg ${TAG_CLS[tag]}`}>
                          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-slate-800">{title}</span>
                            <span className={`rounded-full px-2 py-0.5 text-[11px] ${TAG_CLS[tag]}`}>{tag === "All" ? "Complete" : tag}</span>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-white/10 dark:text-slate-300">{isExcel ? "Excel" : "CSV"}</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
                            <span className="break-all font-mono">{f.name}</span>
                            <span>· {kb(f.size)}</span>
                            <span className="flex items-center gap-1">
                              · <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                              created {when(f.mtime)}
                            </span>
                          </div>
                        </div>
                      </div>
                      <a href={`${API_URL}${f.url}`} download className="group inline-flex flex-none items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700">
                        Download
                        <svg viewBox="0 0 24 24" className="h-4 w-4 transition-transform group-hover:translate-y-0.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4v12M8 12l4 4 4-4M4 20h16" /></svg>
                      </a>
                    </div>
                  );
                })}
              </div>
            </Card>
          </Reveal>
        ))
      )}

      <p className="text-xs text-slate-400">Files live in <code>storage/exports</code> (URLs) and <code>tools/aliff-automation/data</code> (Aliff inputs). Re-run <a href="/revalidate" className="text-brand-600 hover:underline">Revalidate</a> to refresh.</p>
    </div>
  );
}
