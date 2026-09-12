import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** What the user chose. "system" defers to the OS. */
export type ThemePreference = "light" | "dark" | "system";
/** What is actually painted; "system" has been resolved away. */
type Theme = "light" | "dark";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<{
  theme: Theme;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  toggle: () => void;
}>({
  theme: "light",
  preference: "system",
  setPreference: () => {},
  toggle: () => {},
});

function initialPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  // Earlier versions stored only the resolved theme, so "light"/"dark" here may
  // be a preference the user set OR one we saved on their behalf. Treating it
  // as explicit is the safe reading: it keeps the look they last saw.
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" || saved === "system"
    ? saved
    : "system";
}

const systemTheme = (): Theme =>
  typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches
    ? "dark"
    : "light";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(initialPreference);
  const [system, setSystem] = useState<Theme>(systemTheme);

  // Follow the OS while — and only while — it is what we're deferring to.
  useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  const theme: Theme = preference === "system" ? system : preference;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, preference);
  }, [preference]);

  const value = useMemo(
    () => ({
      theme,
      preference,
      setPreference,
      // The header button flips what's on screen, which means committing to
      // the opposite of the resolved theme rather than staying on "system".
      toggle: () => setPreference(theme === "dark" ? "light" : "dark"),
    }),
    [theme, preference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
