import { cn } from "@/lib/utils";

export function ProgressBar({
  value,
  total,
  className,
  barClassName,
}: {
  value: number;
  total: number;
  className?: string;
  barClassName?: string;
}) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-paper-3", className)}>
      <div
        className={cn("h-full rounded-full bg-teal transition-[width] duration-200 ease-out", barClassName)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
