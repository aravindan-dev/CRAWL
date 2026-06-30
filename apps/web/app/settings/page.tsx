"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { Card, Button } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { Reveal } from "../../components/motion";
import { KeywordEditor } from "../../components/KeywordEditor";
import { CrawlSettingsPanel } from "../../components/CrawlSettingsPanel";

interface Field {
  key: string;
  group: string;
  label: string;
  type: "number" | "text" | "select" | "secret";
  note: string;
  options?: string[];
  min?: number;
  max?: number;
  readOnly?: boolean;
  value: string;
  isSet?: boolean;
}
interface SettingsResp {
  groups: { name: string; fields: Field[] }[];
}

const fieldCls = "w-full max-w-md rounded-lg border border-slate-300 bg-white/60 px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 disabled:bg-slate-50 disabled:text-slate-500 dark:bg-white/5";

export default function SettingsPage() {
  const [groups, setGroups] = useState<SettingsResp["groups"]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => api.get<SettingsResp>("/ops/settings").then((r) => setGroups(r.groups)).catch((e) => setMsg(String(e)));
  useEffect(() => { load(); }, []);

  const set = (k: string, v: string) => setEdits((e) => ({ ...e, [k]: v }));
  const valOf = (f: Field) => (f.key in edits ? edits[f.key]! : f.value);

  const save = async () => {
    if (Object.keys(edits).length === 0) { setMsg("Nothing changed."); return; }
    setSaving(true);
    setMsg("");
    try {
      const r = await api.put<{ updated: string[] } & SettingsResp>("/ops/settings", edits);
      setGroups(r.groups);
      setEdits({});
      setMsg(`Saved ${r.updated.length} setting(s). Crawl/AI changes take effect when the crawler/API is restarted.`);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty = Object.keys(edits).length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Configure"
        title="Settings"
        subtitle="Every option you used to set on the command line — now here, with plain-English notes. Changes are saved to config."
        actions={<Button onClick={save} disabled={saving}>{saving ? "Saving…" : dirty ? `Save changes (${dirty})` : "Save changes"}</Button>}
      />

      {msg && <Reveal><Card className="border-brand-100 bg-brand-50 p-3 text-sm text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">{msg}</Card></Reveal>}

      {/* Crawl engine tuning lives at the very top of Settings (moved off the Crawl page). */}
      <Reveal><CrawlSettingsPanel /></Reveal>

      <Reveal>
        <Card className="flex items-start gap-3 border-amber-200 bg-amber-50/80 p-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          <svg viewBox="0 0 24 24" className="mt-0.5 h-5 w-5 flex-none" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          <div>After changing crawl or AI settings, restart the crawler (<code>run-crawler.bat</code>) — and the API for AI changes — so they take effect.</div>
        </Card>
      </Reveal>

      {groups.map((g) => (
        <Reveal key={g.name}>
          <Card className="p-5">
            <div className="mb-4 text-sm font-semibold uppercase tracking-[0.12em] text-slate-500">{g.name}</div>
            <div className="space-y-5">
              {g.fields.map((f) => (
                <div key={f.key} className="grid grid-cols-1 gap-2 border-t border-slate-100 pt-4 first:border-0 first:pt-0 dark:border-white/5 md:grid-cols-[260px,1fr] md:items-start">
                  <div>
                    <label className="block text-sm font-medium text-slate-800">{f.label}</label>
                    <code className="text-[11px] text-slate-400">{f.key}</code>
                  </div>
                  <div>
                    {f.type === "select" ? (
                      <select className={fieldCls} disabled={f.readOnly} value={valOf(f)} onChange={(e) => set(f.key, e.target.value)}>
                        {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : f.type === "secret" ? (
                      <input type="password" autoComplete="off" placeholder={f.isSet ? "•••••••• (set — leave blank to keep)" : "not set"} className={fieldCls} value={valOf(f)} onChange={(e) => set(f.key, e.target.value)} />
                    ) : (
                      <input type={f.type === "number" ? "number" : "text"} min={f.min} max={f.max} disabled={f.readOnly} className={fieldCls} value={valOf(f)} onChange={(e) => set(f.key, e.target.value)} />
                    )}
                    <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">{f.note}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </Reveal>
      ))}

      <KeywordEditor />

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
      </div>
    </div>
  );
}
