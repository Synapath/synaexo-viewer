type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
export type RecordDiagnostic = (event: string, data?: Record<string, Value>) => void;

export function createDiagnostics() {
  const capacity = 600;
  const events: { timeMs: number; event: string; data?: Record<string, Value> }[] = [];
  let next = 0, dropped = 0;
  const record: RecordDiagnostic = (event, data) => {
    if (events.length === capacity) dropped++;
    events[next] = { timeMs: Math.round(performance.now()), event, data };
    next = (next + 1) % capacity;
  };
  function download() {
    const date = new Date().toISOString();
    const entry = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')).at(-1);
    const report = {
      format: "synaexo-viewer-log",
      version: 1,
      exportedAt: date,
      entry: entry ? new URL(entry.src).pathname.split("/").at(-1) : null,
      browser: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      dropped,
      events: [...events.slice(next), ...events.slice(0, next)],
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `synaexo-viewer-${date.replace(/[:.]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { record, download };
}
