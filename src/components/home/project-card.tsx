import { Clock, MoreHorizontal } from "lucide-react";
import type { Project } from "@/lib/data";
import { Card } from "@/components/ui/card";
import { LangTag } from "@/components/ui/lang-tag";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProjectCover } from "./project-cover";

export function ProjectCard({
  project,
  onOpen,
}: {
  project: Project;
  onOpen?: () => void;
}) {
  const pct = Math.round((project.pagesReviewed / project.pagesTotal) * 100);

  return (
    <Card
      onClick={onOpen}
      className="group cursor-pointer bg-surface p-3 transition-all duration-150 ease-out hover:-translate-y-0.5 hover:border-line-2 hover:shadow-paper-md"
    >
      <ProjectCover project={project} />

      <div className="px-1 pt-3 pb-1">
        <div className="mb-1 flex items-center justify-between">
          <LangTag lang={project.language} />
          <button
            onClick={(e) => e.stopPropagation()}
            className="cursor-pointer rounded p-1 text-ink-3"
            aria-label="More options"
          >
            <MoreHorizontal size={16} />
          </button>
        </div>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="mt-1.5 min-h-10 font-serif text-base font-medium leading-tight text-ink line-clamp-2">
                {project.title}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">{project.title}</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="mt-3.5">
          <div className="mb-3 flex items-center justify-between text-xs text-ink-2">
            <StatusPill status={project.status} size="sm" />
            <span className="font-mono text-ink-3">
              {project.pagesReviewed}/{project.pagesTotal} pp
            </span>
          </div>
          <ProgressBar
            value={project.pagesReviewed}
            total={project.pagesTotal}
            barClassName={project.status === "done" ? "bg-teal" : "bg-amber"}
          />
          <div className="mt-2 flex justify-between text-[11.5px] text-ink-3">
            <span className="flex items-center gap-1">
              <Clock size={11} strokeWidth={1.8} />
              {project.lastEdited}
            </span>
            <span className="font-mono">{pct}%</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
