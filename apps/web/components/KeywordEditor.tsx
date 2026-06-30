"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { Card, Button } from "./ui";
import { Reveal } from "./motion";

interface KeywordSets {
  eligibility: string[];
  international: string[];
  evidence: string[];
  scholarship: string[];
}
interface KeywordsResp {
  defaults: KeywordSets;
  custom: Partial<KeywordSets>;
}

const CATS: { key: keyof KeywordSets; label: string; note: string }[] = [
  {
    key: "eligibility",
    label: "Eligibility / criteria words",
    note: "Words that mark an entry-requirements / admission-criteria page (e.g. eligibility, entry requirements, admission criteria, prerequisites). Used to find and score links and to confirm a page is really about eligibility.",
  },
  {
    key: "international",
    label: "International-student words",
    note: "Words that mark international / overseas applicant content (e.g. international students, overseas, English language requirements, visa). Boosts links aimed at international entry.",
  },
  {
    key: "evidence",
    label: "On-page evidence words",
    note: "Words the validator looks for IN the page text to confirm it is genuinely an eligibility page (not just a keyword in the URL). Used by Validate & verify.",
  },
  {
    key: "scholarship",
    label: "Scholarship / funding words",
    note: "Words that mark a SCHOLARSHIP / funding page (e.g. scholarship, bursary, financial aid, fee waiver, grant, fellowship). Used by the separate Scholarship crawl & export — kept fully apart from eligibility.",
  },
];

const taCls =
  "w-full min-h-[140px] rounded-lg border border-slate-300 bg-white/60 px-3 py-2 font-mono text-xs leading-relaxed outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5";

const toLines = (arr?: string[]) => (arr ?? []).join("\n");
const fromLines = (s: string) =>
  Array.from(
    new Set(
      s
        .split(/[\n,]/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

export function KeywordEditor() {
  const [data, setData] = useState<KeywordsResp | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () =>
    api
      .get<KeywordsResp>("/ops/keywords")
      .then((r) => {
        setData(r);
        setDrafts(Object.fromEntries(CATS.map((c) => [c.key, toLines(r.custom[c.key])])));
      })
      .catch((e) => setMsg(String(e)));
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg("");
    try {
      const body = Object.fromEntries(CATS.map((c) => [c.key, fromLines(drafts[c.key] ?? "")])) as unknown as KeywordSets;
      const r = await api.put<KeywordsResp>("/ops/keywords", body);
      setData(r);
      const total = Object.values(body).reduce((n, a) => n + a.length, 0);
      setMsg(`Saved ${total} custom keyword(s). These are added to the built-in list. Restart the crawler/API for crawl changes to take effect.`);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!data) {
    return (
      <Reveal>
        <Card className="p-5 text-sm text-slate-500">Loading keywords…</Card>
      </Reveal>
    );
  }

  return (
    <Reveal>
      <Card className="p-5">
        <div className="mb-1 flex items-center justify-between gap-3">
          <div className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-500">Eligibility keywords</div>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save keywords"}
          </Button>
        </div>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-slate-500">
          Add your own words (one per line, or comma-separated) so no eligibility / criteria page is missed — they are
          merged with the built-in multilingual list below. Matching is case-insensitive and treats spaces, hyphens and
          underscores the same. Leave a box empty to use only the built-ins.
        </p>

        {msg && (
          <div className="mb-4 rounded-lg border border-brand-100 bg-brand-50 p-3 text-sm text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">
            {msg}
          </div>
        )}

        <div className="space-y-6">
          {CATS.map((c) => (
            <div key={c.key} className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-5 first:border-0 first:pt-0 dark:border-white/5 md:grid-cols-[280px,1fr]">
              <div>
                <label className="block text-sm font-medium text-slate-800">{c.label}</label>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">{c.note}</p>
                <p className="mt-2 text-[11px] text-slate-400">
                  Built-in: {data.defaults[c.key].length} words · your additions: {fromLines(drafts[c.key] ?? "").length}
                </p>
              </div>
              <div>
                <textarea
                  className={taCls}
                  value={drafts[c.key] ?? ""}
                  placeholder="one keyword per line…"
                  onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))}
                />
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-600">
                    Show built-in {c.label.toLowerCase()} ({data.defaults[c.key].length})
                  </summary>
                  <div className="mt-2 max-h-40 overflow-auto rounded-lg border border-slate-100 bg-slate-50/60 p-2 text-[11px] leading-relaxed text-slate-500 dark:border-white/5 dark:bg-white/5">
                    {data.defaults[c.key].join(" · ")}
                  </div>
                </details>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </Reveal>
  );
}
