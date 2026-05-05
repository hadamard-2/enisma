import type { CoverPalette, Project } from "@/lib/data";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type Swatch = { bg: string; ink: string; accent: string };

const LIGHT_PALETTES: Record<CoverPalette, Swatch> = {
  warm: { bg: "#E8DEC9", ink: "#5C4A2E", accent: "#C29A55" },
  teal: { bg: "#D6E8E0", ink: "#2D5346", accent: "#5E957F" },
  rose: { bg: "#EAD8D5", ink: "#6E3A39", accent: "#B26F6A" },
  amber: { bg: "#EFDFC0", ink: "#6B4815", accent: "#B27F2A" },
  slate: { bg: "#D8D9DA", ink: "#3A3D42", accent: "#6B7079" },
};

const DARK_PALETTES: Record<CoverPalette, Swatch> = {
  warm: { bg: "#3A2F20", ink: "#E8D4AC", accent: "#B89154" },
  teal: { bg: "#1F3530", ink: "#A8D4C4", accent: "#5E9580" },
  rose: { bg: "#3A2522", ink: "#E8B8B3", accent: "#C47872" },
  amber: { bg: "#3D2E15", ink: "#E8C98A", accent: "#C79744" },
  slate: { bg: "#28292C", ink: "#BCC0C6", accent: "#7A7F88" },
};

export function ProjectCover({
  project,
  size = "md",
}: {
  project: Project;
  size?: "sm" | "md";
}) {
  const { theme } = useTheme();
  const palettes = theme === "dark" ? DARK_PALETTES : LIGHT_PALETTES;
  const p = palettes[project.cover] ?? palettes.warm;
  return (
    <div
      className={cn(
        "relative flex items-end overflow-hidden rounded-lg p-3.5",
        size === "sm" ? "h-[110px]" : "h-[150px]",
      )}
      style={{
        background: p.bg,
        borderTop: `1px solid ${p.accent}33`,
        borderLeft: `1px solid ${p.accent}33`,
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage: `repeating-linear-gradient(180deg, ${p.accent}15 0 1px, transparent 1px 28px)`,
        }}
      />
      <div
        className="absolute top-0 bottom-0 left-0 w-1.5 opacity-50"
        style={{ background: p.accent }}
      />
      <div className="relative z-10">
        <div
          className="mb-1 font-mono text-[10px] uppercase tracking-wider opacity-70"
          style={{ color: p.ink }}
        >
          Textbook
        </div>
        <div
          className={cn(
            "max-w-[85%] font-serif font-semibold leading-tight",
            size === "sm" ? "text-sm" : "text-base",
          )}
          style={{ color: p.ink }}
        >
          {project.title}
        </div>
      </div>
    </div>
  );
}
