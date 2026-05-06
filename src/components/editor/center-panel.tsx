import { cn } from "@/lib/utils";
import { formatShortcut, MOD } from "@/lib/platform";
import type { PageContent } from "@/lib/editor-data";

export type View = "pdf" | "split" | "edit";

export function CenterPanel({
  page,
  content,
  text,
  setText,
  saved,
  view,
}: {
  page: number;
  content: PageContent;
  text: string;
  setText: (t: string) => void;
  saved: boolean;
  view: View;
}) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const seconds = Math.round(text.length / 14);

  return (
    <section className="flex h-full min-w-0 flex-col bg-paper">
      <div className="flex min-h-0 flex-1">
        {view !== "edit" && (
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col pt-13 pb-3",
              view === "split" ? "pr-2 pl-3" : "px-3",
            )}
          >
            <div className="mb-2 font-mono text-[10.5px] tracking-widest text-ink-3 uppercase">
              PDF preview · source page {page}
            </div>
            <PdfPage page={page} content={content} />
          </div>
        )}

        {view !== "pdf" && (
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col pt-13 pb-3",
              view === "split" ? "pr-3 pl-2" : "px-3",
            )}
          >
            <div className="mb-2 flex justify-between font-mono text-[10.5px] tracking-widest uppercase">
              <span className="text-ink-3">Extracted text · editable</span>
              <span className={saved ? "text-ink-3" : "text-amber-ink"}>
                {saved ? "saved" : "unsaved changes"}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface px-5 py-4 shadow-paper-sm">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="min-h-0 flex-1 resize-none border-0 bg-transparent font-serif text-base leading-relaxed text-ink outline-none"
                style={{ letterSpacing: "0.005em" }}
              />
              <div className="mt-2.5 flex justify-between border-t border-dashed border-line pt-2.5 text-[11px] text-ink-3">
                <span>
                  {wordCount} words · ~{seconds}s spoken
                </span>
                <span className="inline-flex items-center gap-2.5">
                  <Kbd>{formatShortcut(MOD, "Z")}</Kbd> undo
                  <Kbd>{formatShortcut(MOD, "S")}</Kbd> save
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function PdfPage({ page, content }: { page: number; content: PageContent }) {
  const paragraphs = content.body.split("\n\n");
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface px-9 py-8 font-serif text-ink-2 shadow-paper-sm">
      <div className="mb-4 flex justify-between border-b border-line pb-2 font-mono text-[10.5px] tracking-widest text-ink-4 uppercase">
        <span>{content.chapter} · Plant Biology</span>
        <span>{page}</span>
      </div>

      <div className="mb-4 text-[22px] font-medium tracking-tight text-ink">
        {content.heading}
      </div>

      <div className="text-[15px] leading-relaxed">
        {paragraphs.map((para, i) => {
          const trimmed = para.trim();
          const isEquation =
            trimmed.startsWith("6 CO") || trimmed.startsWith("Glucose");
          return (
            <p
              key={i}
              className={cn(
                "mb-3.5",
                isEquation
                  ? "rounded-md bg-paper-2 px-3.5 py-2.5 text-center font-mono text-[13px] text-ink"
                  : "text-left text-ink-2",
              )}
            >
              {para}
            </p>
          );
        })}
      </div>

      {content.figure && (
        <div className="mt-4 rounded-lg border border-dashed border-line-2 bg-paper-2 p-3.5">
          <div
            className="mb-2 grid h-[90px] place-items-center rounded font-mono text-[11px] tracking-wider text-ink-3"
            style={{
              backgroundImage:
                "repeating-linear-gradient(135deg, var(--paper-3) 0 8px, var(--paper-2) 8px 16px)",
            }}
          >
            [ figure illustration ]
          </div>
          <div className="text-[12px] text-ink-3 italic">{content.figure}</div>
        </div>
      )}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-line border-b-2 bg-surface px-1.5 py-px font-mono text-[10.5px] leading-tight text-ink-3">
      {children}
    </span>
  );
}
