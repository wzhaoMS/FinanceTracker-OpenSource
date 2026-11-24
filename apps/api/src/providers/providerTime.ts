export function parseProviderTime(input: string | null | undefined, timeZone: string, now = Date.now()): number | null {
  if (!input) return null;
  const normalized = input.trim().replace(' ', 'T');
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) {
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now ? timestamp : null;
  }
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const wallTime = Date.UTC(year, month - 1, day, hour, minute, second);
  if (new Date(wallTime).toISOString().slice(0, 19) !== normalized) return null;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  let timestamp = wallTime;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    if (observed === wallTime) return timestamp > 0 && timestamp <= now ? timestamp : null;
    timestamp += wallTime - observed;
  }
  return null;
}