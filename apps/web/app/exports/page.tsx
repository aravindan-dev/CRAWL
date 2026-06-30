"use client";

import { useState } from "react";
import { api, API_URL } from "../../lib/api";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { Card, StatCard, Button } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { Reveal, Stagger, Item } from "../../components/motion";

interface FileRow { name: string; size: number; url: string; group: string }
interface Counts { universityUrls: number; courseUrls: number; totalUrls: number; generatedAt: string | null }

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

export default function ExportsPage() {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);

  const load = () => {
    api.get<{ files: FileRow[] }>("/ops/files").then((r) => setFiles(r.files)).catch(() => {});
    api.get<Counts>("/ops/export-counts").then(setCounts).catch(() => {});
  };
  useAutoRefresh(load, 5000);

  const groups = [...new Set(files.map((f) => f.group))];
  const isUni = (n: string) => /UNIVERSITY|universities/i.test(n);

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
        <Item><StatCard label="Last generated" value={counts?.generatedAt ? new Date(counts.generatedAt).toLocaleDateString() : "—"} icon={<svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>} /></Item>
      </Stagger>

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
                {files.filter((f) => f.group === g).map((f) => (
                  <div key={f.name} className="flex items-center justify-between rounded-xl border border-slate-100 px-4 py-3 transition-colors hover:bg-slate-50/60 dark:border-white/10 dark:hover:bg-white/5">
                    <div className="flex items-center gap-3">
                      <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg ${isUni(f.name) ? "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300" : "bg-teal-100 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300"}`}>
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                      </span>
                      <div>
                        <div className="font-medium text-slate-800">
                          {f.name}
                          <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] ${isUni(f.name) ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" : "bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300"}`}>
                            {isUni(f.name) ? "University" : "Course"}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400">{kb(f.size)} · {f.name.endsWith(".xlsx") ? "Excel" : "CSV"}</div>
                      </div>
                    </div>
                    <a href={`${API_URL}${f.url}`} download className="group inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-brand-500 to-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:shadow-glow">
                      Download
                      <svg viewBox="0 0 24 24" className="h-4 w-4 transition-transform group-hover:translate-y-0.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4v12M8 12l4 4 4-4M4 20h16" /></svg>
                    </a>
                  </div>
                ))}
              </div>
            </Card>
          </Reveal>
        ))
      )}

      <p className="text-xs text-slate-400">Files live in <code>storage/exports</code> (URLs) and <code>tools/aliff-automation/data</code> (Aliff inputs). Re-run <a href="/revalidate" className="text-brand-600 hover:underline">Revalidate</a> to refresh.</p>
    </div>
  );
}
