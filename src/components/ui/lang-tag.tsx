import { Globe } from "lucide-react";

export function LangTag({ lang }: { lang: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-[3px] font-mono text-[11.5px] tracking-wide text-ink-3">
      <Globe size={11} strokeWidth={1.8} />
      {lang}
    </span>
  );
}
