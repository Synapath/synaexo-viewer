export type DisplayUp = [number, number, number];

export function parseDisplayUp(value: unknown): DisplayUp | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 3 ||
      !value.every((component) => typeof component === "number" && Number.isFinite(component)))
    throw new Error("三维显示向上轴无效");
  const scale = Math.max(...value.map(Math.abs));
  if (scale === 0) throw new Error("三维显示向上轴无效");
  const [axisX, axisY, axisZ] = value.map((component) => component / scale);
  const length = Math.hypot(axisX, axisY, axisZ);
  return [axisX / length, axisY / length, axisZ / length];
}
