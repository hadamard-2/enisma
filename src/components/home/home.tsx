import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AudioLines,
  Check,
  Clock,
  FileText,
  Layers,
  ListFilter,
  Plus,
  Search,
  Settings,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { listProjects, type ProjectSummary } from "@/lib/api";
import { useRelativeTime } from "@/lib/use-relative-time";
import { useRegisterCommands } from "@/lib/app-commands";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectCard } from "./project-card";
import { ImportDialog } from "./import-dialog";
import { SettingsDialog } from "@/components/settings/settings-dialog";

type Filter = "All" | "Recent" | "In progress" | "Completed";

export function Home() {
  const { t } = useTranslation();
  const since = useRelativeTime();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"recent" | "title" | "progress">("recent");
  const [showCompleted, setShowCompleted] = useState(true);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refresh = useCallback(() => {
    listProjects().then(setProjects).catch(console.error);
  }, []);

  useEffect(refresh, [refresh]);

  async function pickFile() {
    const chosen = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof chosen === "string") setPending(chosen);
  }

  // File > Import PDF… is the same picker as the card on this page.
  useRegisterCommands(
    useMemo(() => ({ importPdf: () => void pickFile() }), []),
  );

  const navItems = useMemo(
    () => [
      { label: t("nav.allProjects"), key: "All" as const, icon: Layers, count: projects.length },
      {
        label: t("nav.recent"),
        key: "Recent" as const,
        icon: Clock,
        count: projects.filter((p) => Date.now() - new Date(p.updatedAt).getTime() < 86_400_000)
          .length,
      },
      {
        label: t("nav.inProgress"),
        key: "In progress" as const,
        icon: FileText,
        count: projects.filter((p) => p.status === "in-progress").length,
      },
      {
        label: t("nav.completed"),
        key: "Completed" as const,
        icon: Check,
        count: projects.filter((p) => p.status === "done").length,
      },
    ],
    [projects, t],
  );

  const filtered = useMemo(() => {
    const list = projects.filter((p) => {
      if (filter === "Completed" && p.status !== "done") return false;
      if (filter === "In progress" && p.status !== "in-progress") return false;
      if (filter === "Recent" && Date.now() - new Date(p.updatedAt).getTime() >= 86_400_000)
        return false;
      if (!showCompleted && p.status === "done") return false;
      if (query && !p.title.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
    if (sortBy === "title") {
      list.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortBy === "progress") {
      list.sort(
        (a, b) =>
          b.pagesReviewed / b.pageCount - a.pagesReviewed / a.pageCount,
      );
    }
    return list;
  }, [projects, filter, query, sortBy, showCompleted]);

  return (
    <div className="flex min-h-0 flex-1">
      {/* SIDEBAR */}
      <aside className="flex w-58 shrink-0 flex-col border-r border-line bg-paper-2 px-4 py-5">
        <div className="mb-5 flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md border border-ink bg-ink text-paper">
            <AudioLines size={16} />
          </span>
          <span className="font-sans text-lg font-medium tracking-tight text-ink">
            {t("app.name")}
          </span>
        </div>

        <Button size="lg" className="mb-4 w-full" onClick={pickFile}>
          <Plus />
          {t("nav.newProject")}
        </Button>

        <div className="mb-1 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-3">
          {t("nav.library")}
        </div>

        {navItems.map((it) => {
          const active = filter === it.key;
          const IconCmp = it.icon;
          return (
            <button
              key={it.key}
              onClick={() => setFilter(it.key)}
              className={cn(
                "mb-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px]",
                active
                  ? "bg-surface font-medium text-ink shadow-paper-sm"
                  : "bg-transparent font-normal text-ink-2",
              )}
            >
              <IconCmp
                size={15}
                strokeWidth={1.6}
                className={active ? "text-ink" : "text-ink-3"}
              />
              <span className="flex-1">{it.label}</span>
              <span className="font-mono text-[11px] text-ink-3">{it.count}</span>
            </button>
          );
        })}

        <div className="flex-1" />

        <button
          onClick={() => setSettingsOpen(true)}
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] text-ink-2 transition-colors hover:bg-surface hover:text-ink"
        >
          <Settings size={15} strokeWidth={1.6} className="text-ink-3" />
          <span className="flex-1">{t("nav.settings")}</span>
        </button>
      </aside>

      {/* MAIN */}
      <main className="flex-1 overflow-auto px-9 pt-7 pb-15">
        <div className="mb-2 flex items-end justify-between">
          <div>
            <h1 className="m-0 font-serif text-3xl font-medium tracking-tight text-ink">
              {t("library.heading")}
            </h1>
            <p className="mt-1.5 text-sm text-ink-3">
              {projects[0]
                ? t("library.subtitleWithActivity", {
                    count: filtered.length,
                    time: since(projects[0].updatedAt),
                  })
                : t("library.subtitle", { count: filtered.length })}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative w-60">
              <Search
                size={14}
                className="absolute top-1/2 left-3 -translate-y-1/2 z-10 text-muted-foreground"
              />
              <Input
                placeholder={t("library.search")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="bg-surface pl-8"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="lg" className="bg-surface">
                  <ListFilter />
                  {t("library.view")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>{t("library.sortBy")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={sortBy}
                  onValueChange={(v) => setSortBy(v as typeof sortBy)}
                >
                  <DropdownMenuRadioItem value="recent">{t("library.sortRecent")}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="title">{t("library.sortTitle")}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="progress">{t("library.sortProgress")}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("library.show")}</DropdownMenuLabel>
                <DropdownMenuCheckboxItem
                  checked={showCompleted}
                  onCheckedChange={setShowCompleted}
                >
                  {t("library.showCompleted")}
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="my-6 h-px bg-line" />

        <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-5">
          <NewProjectTile onClick={pickFile} />
          {filtered.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              onOpen={() => navigate(`/project/${p.id}`)}
            />
          ))}
        </div>
      </main>

      <ImportDialog
        key={pending ?? "none"}
        srcPath={pending}
        onCancel={() => setPending(null)}
        onImported={(id) => {
          setPending(null);
          refresh();
          navigate(`/project/${id}`);
        }}
      />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

function NewProjectTile({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className="group flex min-h-[264px] cursor-pointer flex-col justify-between rounded-xl border-[1.5px] border-dashed border-line-2 bg-transparent p-4.5 text-left text-ink-2 transition-colors duration-150 hover:border-teal hover:bg-paper-2"
    >
      <div className="grid size-9.5 place-items-center rounded-lg border border-line bg-paper-2 text-ink-2">
        <Upload size={18} />
      </div>
      <div>
        <div className="mb-1.5 font-serif text-[17px] font-medium text-ink">
          {t("library.newTileTitle")}
        </div>
        <div className="text-[12.5px] leading-relaxed text-ink-3">
          {t("library.newTileBody")}
        </div>
      </div>
    </button>
  );
}
