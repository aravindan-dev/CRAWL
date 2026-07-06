export interface HeroChip {
  label: string;
  value: string | number;
  accent?: "brand" | "emerald" | "amber" | "slate";
}

const ACCENT: Record<NonNullable<HeroChip["accent"]>, string> = {
  brand: "text-brand-600 dark:text-brand-300",
  emerald: "text-emerald-600 dark:text-emerald-300",
  amber: "text-accent-600 dark:text-accent-300",
  slate: "text-slate-700 dark:text-slate-200",
};

/**
 * Home dashboard hero: clean panel with an eyebrow, headline, subtitle and a
 * row of live stat chips. Renders instantly — the entrance fade + chip stagger
 * were removed so the landing page paints immediately (fast over fancy).
 */
export function Hero({ eyebrow, title, subtitle, chips = [] }: { eyebrow: string; title: string; subtitle: string; chips?: HeroChip[] }) {
  return (
    <section className="glass p-7 md:p-9">
      <span className="eyebrow">
        <span className="h-2 w-2 rounded-full bg-brand-500" />
        {eyebrow}
      </span>

      <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 md:text-[2.4rem] md:leading-[1.1]">
        {title}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 md:text-[15px] dark:text-slate-300">{subtitle}</p>

      {chips.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2.5">
          {chips.map((c) => (
            <div
              key={c.label}
              className="glass-soft flex items-center gap-2 rounded-full px-3.5 py-1.5"
            >
              <span className={`tnum text-base font-bold ${ACCENT[c.accent ?? "slate"]}`}>{c.value}</span>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{c.label}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
