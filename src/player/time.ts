export function nearestFrame(times: number[], seconds: number) {
  const stamp = seconds * 1e9;
  let lo = 0,
    hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < stamp) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(times[lo - 1] - stamp) < Math.abs(times[lo] - stamp)
    ? lo - 1
    : lo;
}
export function clock(ns: number) {
  const seconds = Math.max(0, Math.floor(ns / 1e9));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

export function containingFrame(times: number[], seconds: number) {
  const stamp = seconds * 1e9;
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= stamp) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}
export function seekSeconds(times: number[], frame: number, duration: number) {
  const start = times[frame],
    end =
      times[frame + 1] ??
      (Number.isFinite(duration) && duration * 1e9 > start
        ? duration * 1e9
        : start + Math.max(1, times[frame] - times[Math.max(0, frame - 1)]));
  // Seek inside the frame interval, not just before a rounded MP4 timestamp.
  return (start + (end - start) / 2) / 1e9;
}
