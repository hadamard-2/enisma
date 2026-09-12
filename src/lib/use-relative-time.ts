import { useTranslation } from "react-i18next";

import { relativeTime } from "./time";

/**
 * Render an ISO-8601 timestamp as a translated relative-time phrase.
 *
 * Returns a formatter rather than a string so a caller with several timestamps
 * (the project grid) resolves one translator for all of them.
 */
export function useRelativeTime() {
  const { t } = useTranslation();
  return (iso: string, now?: Date) => {
    const r = relativeTime(iso, now);
    return "count" in r
      ? t(`time.${r.key}`, { count: r.count })
      : t(`time.${r.key}`);
  };
}
