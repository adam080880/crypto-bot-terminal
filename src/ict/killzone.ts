import type { KillZoneName, KillZoneStatus } from "./types.ts";

const ZONES: Record<KillZoneName, [number, number]> = {
  asia:    [0, 4],
  london:  [7, 10],
  newyork: [13, 16],
};

const ORDER: KillZoneName[] = ["asia", "london", "newyork"];

export function getKillZone(now = new Date()): KillZoneStatus {
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;

  let active: KillZoneName | null = null;
  for (const name of ORDER) {
    const r = ZONES[name];
    if (utcH >= r[0] && utcH < r[1]) { active = name; break; }
  }

  let next: KillZoneStatus["next"] = null;
  for (const name of ORDER) {
    const r = ZONES[name];
    let hoursUntil = r[0] - utcH;
    if (hoursUntil <= 0) hoursUntil += 24;
    const mins = Math.round(hoursUntil * 60);
    if (!next || mins < next.startsInMin) next = { name, startsInMin: mins };
  }
  if (active && next?.name === active) next = null;

  return { active, next, utcHour: now.getUTCHours() };
}
