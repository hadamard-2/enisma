import { useTranslation } from "react-i18next";
import { Clock, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { ProjectSummary } from "@/lib/api";
import { useRelativeTime } from "@/lib/use-relative-time";
import { Card } from "@/components/ui/card";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StatusPill } from "@/components/ui/status-pill";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectCover } from "./project-cover";

export function ProjectCard({
  project,
  onOpen,
  onRename,
  onDelete,
}: {
  project: ProjectSummary;
  onOpen?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const since = useRelativeTime();
  const pct = Math.round((project.pagesReviewed / project.pageCount) * 100);

  return (
    <Card
      onClick={onOpen}
      className="group cursor-pointer bg-surface p-3 transition-all duration-150 ease-out hover:-translate-y-0.5 hover:border-line-2 hover:shadow-paper-md"
    >
      <ProjectCover project={project} />

      <div className="px-1 pt-3 pb-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-h-10 flex-1 font-serif text-base font-medium leading-tight text-ink line-clamp-2">
            {project.title}
          </div>
          {/* The whole card opens the project, so every click inside the menu
              has to be stopped from reaching it — including the one that picks
              an item, which would otherwise open the project it just acted on. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                className="-mt-0.5 cursor-pointer rounded p-1 text-ink-3"
                aria-label={t("projectCard.moreOptions")}
              >
                <MoreHorizontal size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onSelect={() => onRename?.()}>
                <Pencil />
                {t("projectCard.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onDelete?.()}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 />
                {t("projectCard.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mt-3.5">
          <div className="mb-3 flex items-center justify-between text-xs text-ink-2">
            <StatusPill status={project.status} size="sm" />
            <span className="font-mono text-ink-3">
              {t("projectCard.pages", {
                reviewed: project.pagesReviewed,
                total: project.pageCount,
              })}
            </span>
          </div>
          <ProgressBar
            value={project.pagesReviewed}
            total={project.pageCount}
            barClassName={project.status === "done" ? "bg-teal" : "bg-amber"}
          />
          <div className="mt-2 flex justify-between text-[11.5px] text-ink-3">
            <span className="flex items-center gap-1">
              <Clock size={11} strokeWidth={1.8} />
              {since(project.updatedAt)}
            </span>
            <span className="font-mono">{pct}%</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
