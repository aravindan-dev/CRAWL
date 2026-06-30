"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { Card, Button } from "./ui";

type CrawlTarget = "both" | "eligibility" | "scholarship";
interface CrawlSettings {
  CRAWL_CONCURRENCY: number;
  MAX_PAGES_PER_UNIVERSITY: number;
  MAX_CRAWL_DEPTH: number;
  CRAWL_DELAY_MS: number;
  MAX_CRAWL_MINUTES: number;
  CRAWL_TARGET: CrawlTarget;
}

const NUM_FIELDS: { key: keyof CrawlSettings; label: string; min: number; max: number }[] = [
  { key: "CRAWL_CONCURRENCY", label: "Browsers = universities at once", min: 1, max: 12 },
  { key: "MAX_CRAWL_MINUTES", label: "Time budget / university (min)", min: 0, max: 240 },
  { key: "MAX_PAGES_PER_UNIVERSITY", label: "Max pages / university", min: 10, max: 50000 },
  { key: "MAX_CRAWL_DEPTH", label: "Max depth (hops)", min: 1, max: 12 },
  { key: "CRAWL_DELAY_MS", label: "Delay between pages (ms)", min: 0, max: 10000 },
];

const fieldCls = "mt-1 w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5";

/**
 * Recommend crawl settings for a machine's RAM (and CPU cores). RAM is the real
 * limit — each parallel browser uses ~0.7–1.5 GB, and a dev machine also runs
 * Docker + your browser + editor. Tiers are deliberately conservative so the
 * crawl doesn't exhaust memory (which makes Chromium time out and the crawl stall).
 */
function recommendForRam(ramGb: number, cores?: number) {
  let CRAWL_CONCURRENCY: number, MAX_CRAWL_DEPTH: number, MAX_PAGES_PER_UNIVERSITY: number, CRAWL_DELAY_MS: number;
  if (ramGb <= 8) { CRAWL_CONCURRENCY = 2; MAX_CRAWL_DEPTH = 6; MAX_PAGES_PER_UNIVERSITY = 1500; CRAWL_DELAY_MS = 800; }
  else if (ramGb <= 16) { CRAWL_CONCURRENCY = 3; MAX_CRAWL_DEPTH = 8; MAX_PAGES_PER_UNIVERSITY = 3000; CRAWL_DELAY_MS = 600; }
  else if (ramGb <= 32) { CRAWL_CONCURRENCY = 6; MAX_CRAWL_DEPTH = 10; MAX_PAGES_PER_UNIVERSITY = 5000; CRAWL_DELAY_MS = 500; }
  else if (ramGb <= 64) { CRAWL_CONCURRENCY = 10; MAX_CRAWL_DEPTH = 12; MAX_PAGES_PER_UNIVERSITY = 5000; CRAWL_DELAY_MS = 400; }
  else { CRAWL_CONCURRENCY = 12; MAX_CRAWL_DEPTH = 12; MAX_PAGES_PER_UNIVERSITY = 5000; CRAWL_DELAY_MS = 300; }
  if (cores && cores > 0) CRAWL_CONCURRENCY = Math.min(CRAWL_CONCURRENCY, Math.max(1, cores - 1)); // don't exceed CPU
  const MAX_CRAWL_MINUTES = 40; // bound each university so N browsers finish N universities in ~40 min
  return { CRAWL_CONCURRENCY, MAX_CRAWL_DEPTH, MAX_PAGES_PER_UNIVERSITY, CRAWL_DELAY_MS, MAX_CRAWL_MINUTES };
}
const RAM_OPTIONS = [8, 16, 32, 64, 128];

/**
 * Crawl-engine tuning (browsers, time budget, depth, etc.) — lives at the top of
 * the Settings page. Backed by /ops/crawl-settings, separate from the .env settings
 * groups below. Restart the engine for changes to take effect.
 */
export function CrawlSettingsPanel() {
  const [settings, setSettings] = useState<CrawlSettings | null>(null);
  const [system, setSystem] = useState<{ ramGb: number; freeGb: number; cores: number } | null>(null);
  const [ramChoice, setRamChoice] = useState<number>(0); // 0 = use detected RAM
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.get<CrawlSettings>("/ops/crawl-settings").then(setSettings).catch(() => {});
    api.get<{ ramGb: number; freeGb: number; cores: number }>("/ops/system").then(setSystem).catch(() => {});
  }, []);

  const effectiveRam = ramChoice || system?.ramGb || 16;
  const applyAutoTune = () => {
    if (!settings) return;
    const rec = recommendForRam(effectiveRam, system?.cores);
    setSettings({ ...settings, ...rec });
    setMsg(`Auto-tuned for ${effectiveRam} GB RAM${system?.cores ? ` / ${system.cores} cores` : ""}. Review below, then Save & Restart engine.`);
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSaving(true);
    setMsg("");
    try {
      setSettings(await api.put<CrawlSettings>("/ops/crawl-settings", settings));
      setMsg("Saved. Restart the engine on the Crawl & Validate page for the new browser count / pages to take effect.");
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="font-semibold text-slate-900">Crawl engine settings</div>
      <div className="mt-0.5 text-sm text-slate-500">
        How hard the crawler runs. Saved here, applied after you <b>Restart engine</b> on the{" "}
        <a href="/crawl" className="text-brand-600 hover:underline">Crawl &amp; Validate</a> page.
      </div>

      {msg && <div className="mt-3 rounded-lg border border-brand-100 bg-brand-50 p-3 text-sm text-brand-800 dark:border-brand-500/20 dark:bg-brand-500/10 dark:text-brand-200">{msg}</div>}

      <div className="mt-3 flex gap-3 rounded-xl border border-brand-100 bg-brand-50/70 p-3 text-sm text-brand-900 dark:border-brand-500/20 dark:bg-brand-500/10 dark:text-brand-100">
        <svg viewBox="0 0 24 24" className="mt-0.5 h-5 w-5 flex-none text-brand-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
        <div>
          <b>Browsers = universities crawled at the same time.</b> Set it to how many universities you want running in parallel.
          Each university is capped by the <b>time budget</b> (e.g. 40 min) — high-value eligibility/course pages are crawled first — so
          <b>8 browsers finish 8 universities in ~40 minutes</b>, not 8×. More browsers = heavier on memory/CPU: <b>3–4</b> is safe on a
          laptop, <b>6–8</b> needs a powerful machine. Both apply after you <b>Save</b> &amp; <b>Restart engine</b>.
        </div>
      </div>

      {settings ? (
        <>
          {/* RAM-based auto-tune */}
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-white/10 dark:bg-white/[0.03]">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="font-medium text-slate-700">Your machine RAM</span>
                <select className={`${fieldCls} min-w-[200px]`} value={ramChoice} onChange={(e) => setRamChoice(Number(e.target.value))}>
                  <option value={0}>Auto-detect{system ? ` (${system.ramGb} GB${system.cores ? `, ${system.cores} cores` : ""})` : ""}</option>
                  {RAM_OPTIONS.map((r) => <option key={r} value={r}>{r} GB</option>)}
                </select>
              </label>
              <Button variant="secondary" onClick={applyAutoTune}>Auto-tune for this RAM</Button>
              {(() => { const r = recommendForRam(effectiveRam, system?.cores); return (
                <span className="text-xs text-slate-500">→ {r.CRAWL_CONCURRENCY} browsers · depth {r.MAX_CRAWL_DEPTH} · {r.MAX_PAGES_PER_UNIVERSITY.toLocaleString()} pages · {r.CRAWL_DELAY_MS}ms</span>
              ); })()}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              Pick your RAM (or use auto-detect) and click <b>Auto-tune</b> to fill the settings below — then <b>Save</b> &amp; <b>Restart engine</b>.
              RAM is the real limit: each parallel browser uses ~1&nbsp;GB and your machine also runs Docker, your browser and editor — so we stay conservative
              (≈ <b>8GB→2</b>, <b>16GB→3</b>, <b>32GB→6</b>, <b>64GB→10</b> browsers). Too many browsers exhausts memory and the crawl stalls. You can still edit any field manually.
            </p>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
            {NUM_FIELDS.map((f) => (
              <label key={f.key} className="text-sm">
                <span className="font-medium text-slate-700">{f.label}</span>
                <input type="number" min={f.min} max={f.max} className={fieldCls}
                  value={settings[f.key]} onChange={(e) => setSettings({ ...settings, [f.key]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
          <div className="mt-4"><Button onClick={saveSettings} disabled={saving}>{saving ? "Saving…" : "Save settings"}</Button></div>
        </>
      ) : <div className="mt-3 text-sm text-slate-400">Loading…</div>}
    </Card>
  );
}
