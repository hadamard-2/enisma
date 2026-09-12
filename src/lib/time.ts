/**
 * Which relative-time phrase an age falls into, and the number that goes in it.
 *
 * Deliberately returns a key rather than a sentence. The previous version built
 * `${n} minute${n === 1 ? "" : "s"} ago` inline, which is English's two-form
 * plural rule written as code — Amharic, Tigrigna and Oromo do not share it.
 * Choosing the phrase is calendar logic and belongs here; choosing the plural
 * form is grammar and belongs in the catalogue.
 */
export type RelativeTime =
  | { key: "justNow" }
  | { key: "minutesAgo"; count: number }
  | { key: "hoursAgo"; count: number }
  | { key: "yesterday" }
  | { key: "daysAgo"; count: number }
  | { key: "lastWeek" }
  | { key: "weeksAgo"; count: number };

/** Bucket an ISO-8601 timestamp into the library's relative-time phrases. */
export function relativeTime(iso: string, now: Date = new Date()): RelativeTime {
  const seconds = Math.floor((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return { key: "justNow" };

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { key: "minutesAgo", count: minutes };

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: "hoursAgo", count: hours };

  const days = Math.floor(hours / 24);
  if (days === 1) return { key: "yesterday" };
  if (days < 7) return { key: "daysAgo", count: days };

  const weeks = Math.floor(days / 7);
  if (weeks === 1) return { key: "lastWeek" };
  return { key: "weeksAgo", count: weeks };
}
