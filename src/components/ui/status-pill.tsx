import type { ProjectStatus } from "@/lib/data";
import { cn } from "@/lib/utils";

type PageStatus = "reviewed" | "pending" | "skipped";
type Status = ProjectStatus | PageStatus;

const MAP: Record<Status, { bg: string; fg: string; dot: string; label: string }> = {
  reviewed: { bg: "bg-teal-soft", fg: "text-teal-ink", dot: "bg-teal", label: "Reviewed" },
  pending: { bg: "bg-amber-soft", fg: "text-amber-ink", dot: "bg-amber", label: "Pending" },
  skipped: { bg: "bg-slate-soft", fg: "text-ink-3", dot: "bg-slate-x", label: "Skipped" },
  done: { bg: "bg-teal-soft", fg: "text-teal-ink", dot: "bg-teal", label: "Complete" },
  "in-progress": { bg: "bg-amber-soft", fg: "text-amber-ink", dot: "bg-amber", label: "In progress" },
  new: { bg: "bg-paper-2", fg: "text-ink-3", dot: "bg-ink-4", label: "Not started" },
};

export function StatusPill({
  status,
  size = "md",
}: {
  status: Status;
  size?: "sm" | "md";
}) {
  const s = MAP[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium tracking-wide",
        s.bg,
        s.fg,
        size === "sm"
          ? "py-[2px] pr-[7px] pl-[6px] text-[11px]"
          : "py-[3px] pr-[10px] pl-[8px] text-[11.5px]",
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}
