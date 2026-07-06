"use client";

import type { ReactNode } from "react";
import { Card } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { Reveal, Stagger, Item } from "../../components/motion";

function Step({ n, title, last, children }: { n: number; title: string; last?: boolean; children: ReactNode }) {
  return (
    <Item>
      <div className="relative flex gap-4">
        {/* timeline rail */}
        <div className="flex flex-none flex-col items-center">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">
            {n}
          </div>
          {!last && <div className="mt-1 w-px flex-1 bg-slate-200 dark:bg-white/10" />}
        </div>
        <Card hover className="mb-4 flex-1 p-5">
          <div className="font-semibold text-slate-900">{title}</div>
          <div className="mt-1 space-y-1 text-sm leading-relaxed text-slate-600">{children}</div>
        </Card>
      </div>
    </Item>
  );
}

export default function GuidePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Getting started"
        title="How to use this"
        subtitle="The whole flow runs from this dashboard. Do the steps top to bottom."
      />

      <Reveal>
        <Card className="flex items-start gap-3 border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          <svg viewBox="0 0 24 24" className="mt-0.5 h-5 w-5 flex-none" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          <div>
            <b>Before you start:</b> open Docker Desktop, then double-click <code>run-api.bat</code> and <code>run-web.bat</code>.
            For crawling also run <code>run-crawler.bat</code>. Then open this site at <code>http://localhost:3100</code>.
          </div>
        </Card>
      </Reveal>

      <Stagger className="space-y-0" gap={0.06}>
        <Step n={1} title="Add universities — Universities page">
          <p>Go to <b>Universities</b>. Click <b>Download template</b>, fill <code>name, country, base_url</code> in Excel, save, then <b>Upload &amp; import</b> (.xlsx or .csv). Only the name is required — missing websites can be auto-discovered.</p>
        </Step>

        <Step n={2} title="Crawl &amp; Validate — single pass">
          <p>Go to <b>Crawl &amp; Validate</b>. Set <b>Browsers</b> (3–4 is safe), max pages, depth → <b>Save</b>, make sure <code>run-crawler.bat</code> is running, then <b>Crawl all universities</b>.</p>
          <p>This is <b>one process</b>: each URL is crawled <i>and validated inline</i> (its page text must actually prove entry-requirement / scholarship content). Validated links stream into the <b>Validated URLs · live</b> feed one-by-one as they&apos;re found — no separate validation pass.</p>
        </Step>

        <Step n={3} title="Revalidate — de-dup &amp; drop 404s">
          <p>Go to <b>Revalidate</b> and click <b>Revalidate everything</b>. It re-checks reachability, <b>removes duplicates</b>, <b>drops any 404 / broken links</b>, and writes the FINAL Excel/CSV (eligibility + scholarship, separate). It&apos;s quick — content was already verified during the crawl.</p>
        </Step>

        <Step n={4} title="Export &amp; Aliff — build inputs, push, download" last>
          <p>Go to <b>Export &amp; Aliff</b>. Click <b>Build inputs</b> (turns the validated links into the Aliff format), then enter your Aliff <b>email + password</b> (used only for this run, never stored), choose Universities / Courses / Both and a <b>Limit</b>.</p>
          <p><b>Always DRY-RUN first</b> (Limit 5) to preview with no saving. Then uncheck DRY-RUN and <b>Run LIVE</b> (red button) to save. Download every result file from the <b>Deliverable files</b> list.</p>
        </Step>
      </Stagger>

      <Reveal>
        <Card hover className="p-5">
          <div className="flex items-center gap-2 font-semibold text-slate-900">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z" /></svg>
            Good to know
          </div>
          <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
            {[
              <><b>DRY-RUN</b> never saves; <b>LIVE</b> writes real records to Aliff.</>,
              <>University eligibility and course eligibility are <b>never mixed</b> — separate files, separate Aliff sections.</>,
              <>Re-runs are safe: existing values aren&apos;t duplicated, and a save is only counted if it actually persisted.</>,
              <>Only one operation runs at a time — wait for the live log to finish.</>,
              <>Download every result file from <b>Export &amp; Aliff → Deliverable files</b> (or the Download files page).</>,
            ].map((li, i) => (
              <li key={i} className="flex gap-2">
                <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 flex-none text-brand-500" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M20 6 9 17l-5-5" /></svg>
                <span>{li}</span>
              </li>
            ))}
          </ul>
        </Card>
      </Reveal>
    </div>
  );
}
