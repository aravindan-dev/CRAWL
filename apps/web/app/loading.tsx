import { Skeleton } from "../components/ui";

/**
 * Global Suspense fallback (App Router): shown the INSTANT a navigation
 * targets any route segment that doesn't have a more specific loading.tsx,
 * while that segment's server data is still being fetched. Without this,
 * clicking into a route not yet visited this session shows a frozen/blank
 * frame for however long its data takes — this fills that gap immediately,
 * matching each page's actual header+content-grid shape so the swap-in feels
 * like a continuation rather than a jump.
 */
export default function GlobalLoading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-3 w-24 rounded" />
          <Skeleton className="h-7 w-64 rounded" />
        </div>
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="glass space-y-3 p-5">
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-7 w-16 rounded" />
          </div>
        ))}
      </div>
      <div className="glass space-y-3 p-5">
        <Skeleton className="h-4 w-40 rounded" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    </div>
  );
}
