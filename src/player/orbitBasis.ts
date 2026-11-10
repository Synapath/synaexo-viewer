import type { Vector3 } from "three";

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

export function explicitOrbitDirection(up: Vector3): Vector3 {
  const direction = up.clone().set(2, 0, 3).projectOnPlane(up);
  if (direction.lengthSq() < 1e-12)
    direction.set(0, 1, 0).projectOnPlane(up);
  return direction.setLength(Math.sqrt(13)).add(up);
}
