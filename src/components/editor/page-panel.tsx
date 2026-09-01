import { cn } from "@/lib/utils";
import { ProgressBar } from "@/components/ui/progress-bar";
import type { PageMeta } from "@/lib/api";

export type PageFilter = "all" | "done" | "not-done";

interface Counts {
  doneCount: number;
  notDoneCount: number;
}

export function PagePanel({
  pages,
  filter,
  setFilter,
  active,
  setActive,
  counts,
}: {
  pages: PageMeta[];
  filter: PageFilter;
  setFilter: (f: PageFilter) => void;
  active: number;
  setActive: (n: number) => void;
  counts: Counts;
}) {
  const visible =
    filter === "all"
      ? pages
      : pages.filter((p) => (filter === "done" ? p.done : !p.done));
  const pct = Math.round((counts.doneCount / pages.length) * 100);

  const legend: { label: string; n: number; key: "done" | "not-done"; dot: string }[] = [
    { label: "Done", n: counts.doneCount, key: "done", dot: "bg-teal" },
    { label: "Not done", n: counts.notDoneCount, key: "not-done", dot: "bg-amber" },
  ];

  return (
    <aside className="flex h-full min-h-0 flex-col bg-paper-2">
      <div className="pt-13 pr-4 pb-3 pl-4">
        <div className="mb-2.5 flex items-baseline justify-between">
          <span className="font-serif text-[22px] font-medium text-ink">
            {counts.doneCount}
            <span className="font-normal text-ink-3"> / {pages.length}</span>
          </span>
          <span className="font-mono text-[11px] text-ink-3">{pct}%</span>
        </div>
        <ProgressBar value={counts.doneCount} total={pages.length} />

        <div className="mt-3 grid grid-cols-2 gap-1">
          {legend.map((c) => {
            const active = filter === c.key;
            return (
              <button
                key={c.key}
                onClick={() => setFilter(active ? "all" : c.key)}
                className={cn(
                  "flex cursor-pointer flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left",
                  active
                    ? "border-ink-2 bg-surface"
                    : "border-line bg-transparent hover:bg-paper-3",
                )}
              >
                <span className="flex items-center gap-1.5 text-[10.5px] text-ink-3">
                  <span className={cn("size-1.5 rounded-full", c.dot)} />
                  {c.label}
                </span>
                <span className="font-mono text-[13px] font-medium text-ink">
                  {c.n}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="h-px bg-line" />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {visible.map((p) => (
          <PageRow
            key={p.pageNo}
            page={p}
            active={p.pageNo === active}
            onClick={() => setActive(p.pageNo)}
          />
        ))}
      </div>
    </aside>
  );
}

function PageRow({
  page,
  active,
  onClick,
}: {
  page: PageMeta;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "mb-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-md border py-1.5 pr-2 pl-2 text-left",
        active
          ? "border-line-2 bg-surface shadow-paper-sm"
          : "border-transparent bg-transparent hover:bg-paper-3",
      )}
    >
      <div
        className={cn(
          "relative h-10 w-7.5 shrink-0 overflow-hidden rounded-sm border bg-surface",
          active ? "border-line-2" : "border-line",
        )}
      >
        <div
          className="absolute inset-1"
          style={{
            backgroundImage: `repeating-linear-gradient(180deg, rgba(80,65,40,0.45) 0 1.2px, transparent 1.2px 4px)`,
          }}
        />
        <span
          className={cn(
            "absolute top-0.5 right-0.5 size-1.5 rounded-full border border-surface",
            page.done ? "bg-teal" : "bg-amber",
          )}
        />
      </div>

      <span
        className={cn(
          "font-mono text-[12.5px] font-medium",
          page.done ? "text-teal-ink" : "text-amber-ink",
        )}
      >
        p. {page.pageNo}
      </span>
    </button>
  );
}
