export function viewColumns(views: number) {
  if (views <= 3) return Math.max(1, views);
  return views === 4 ? 2 : views <= 6 ? 3 : 4;
}
