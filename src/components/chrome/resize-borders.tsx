import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Mirrors the API's own (unexported) `ResizeDirection` union. */
type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

/**
 * Edge and corner grips that give a frameless window its resize handles back.
 *
 * Turning decorations off also takes away the compositor's resize border, so
 * these thin strips stand in for it: a press hands the drag to the compositor
 * through `startResizeDragging`, which then owns the gesture — there is no
 * pointer tracking of our own here.
 *
 * They are kept narrow on purpose. Each one sits ON TOP of the app, so every
 * pixel it covers is a pixel the UI underneath can't be clicked on; the right
 * edge in particular overlaps the outermost sliver of a 10px scrollbar.
 */

/** Grip thickness along an edge, in CSS px. */
const EDGE = 4;
/** Corner grips are square and larger, so diagonal resizing is catchable. */
const CORNER = 12;

const start = (dir: ResizeDirection) => (e: React.PointerEvent) => {
  // Only a plain left-button press; anything else should reach the app.
  if (e.button !== 0 || !isTauri()) return;
  e.preventDefault();
  getCurrentWindow().startResizeDragging(dir).catch(console.error);
};

export function ResizeBorders({ disabled }: { disabled?: boolean }) {
  // A maximised or fullscreen window has no edges to drag, and leaving live
  // grips there would swallow clicks along the screen edge for nothing.
  if (disabled) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-100">
      <Grip dir="North" style={{ top: 0, left: CORNER, right: CORNER, height: EDGE }} />
      <Grip dir="South" style={{ bottom: 0, left: CORNER, right: CORNER, height: EDGE }} />
      <Grip dir="West" style={{ left: 0, top: CORNER, bottom: CORNER, width: EDGE }} />
      <Grip dir="East" style={{ right: 0, top: CORNER, bottom: CORNER, width: EDGE }} />

      <Grip dir="NorthWest" style={{ top: 0, left: 0, width: CORNER, height: CORNER }} />
      <Grip dir="NorthEast" style={{ top: 0, right: 0, width: CORNER, height: CORNER }} />
      <Grip dir="SouthWest" style={{ bottom: 0, left: 0, width: CORNER, height: CORNER }} />
      <Grip dir="SouthEast" style={{ bottom: 0, right: 0, width: CORNER, height: CORNER }} />
    </div>
  );
}

/** Maps each direction to the cursor the platform uses for that edge. */
const CURSOR: Record<ResizeDirection, string> = {
  North: "ns-resize",
  South: "ns-resize",
  West: "ew-resize",
  East: "ew-resize",
  NorthWest: "nwse-resize",
  SouthEast: "nwse-resize",
  NorthEast: "nesw-resize",
  SouthWest: "nesw-resize",
};

function Grip({
  dir,
  style,
}: {
  dir: ResizeDirection;
  style: React.CSSProperties;
}) {
  return (
    <div
      onPointerDown={start(dir)}
      className="pointer-events-auto fixed"
      style={{ ...style, cursor: CURSOR[dir] }}
    />
  );
}
