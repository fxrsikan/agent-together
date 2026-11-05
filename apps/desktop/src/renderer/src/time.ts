/** Local wall-clock time (HH:MM:SS) of an ISO timestamp; stored times are UTC. */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
}

/** Local date and time of an ISO timestamp, e.g. "11/5 12:25". */
export function when(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}`;
}
