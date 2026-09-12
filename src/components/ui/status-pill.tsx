import { useTranslation } from "react-i18next";
import type { ProjectStatus } from "@/lib/data";
import { cn } from "@/lib/utils";

const MAP: Record<ProjectStatus, { bg: string; fg: string; dot: string; labelKey: string }> = {
  done: { bg: "bg-teal-soft", fg: "text-teal-ink", dot: "bg-teal", labelKey: "status.done" },
  "in-progress": { bg: "bg-amber-soft", fg: "text-amber-ink", dot: "bg-amber", labelKey: "status.inProgress" },
  new: { bg: "bg-paper-2", fg: "text-ink-3", dot: "bg-ink-4", labelKey: "status.new" },
};

export function StatusPill({
  status,
  size = "md",
}: {
  status: ProjectStatus;
  size?: "sm" | "md";
}) {
  const { t } = useTranslation();
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
      {t(s.labelKey)}
    </span>
  );
}
