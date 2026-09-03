const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Formats a timestamp in UTC without `toLocale*`, so the server-rendered and
 * client-rendered strings always agree regardless of the viewer's timezone.
 */
export function formatDateTime(value: string) {
  const date = new Date(value);
  const hour = date.getUTCHours();
  const displayHour = hour % 12 || 12;
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${displayHour}:${String(date.getUTCMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"} UTC`;
}
