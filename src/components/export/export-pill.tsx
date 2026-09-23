import { useTranslation } from "react-i18next";
import { pillLabel } from "@/lib/export-form";
import { cn } from "@/lib/utils";
import { useExport } from "./export-provider";

/** The export's state in the title bar, on every screen. Click opens the view. */
export function ExportPill() {
  const { t } = useTranslation();
  const { status, openView } = useExport();
  const label = pillLabel(status);
  if (!label) return null;
  return (
    <button
      onClick={openView}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium",
        label.kind === "attention"
          ? "border-line bg-paper-2 text-amber-ink"
          : "border-line bg-surface text-ink-2 hover:text-ink",
      )}
    >
      {label.kind === "running"
        ? t("export.pillRunning", { percent: label.percent })
        : label.kind === "ready"
          ? t("export.pillReady")
          : t("export.pillAttention")}
    </button>
  );
}
