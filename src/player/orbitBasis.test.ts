import { Vector3 } from "three";
import { expect, it } from "vitest";
import { explicitOrbitDirection, parseDisplayUp } from "./orbitBasis";

it("frames an explicit depth-camera up axis from slightly above", () => {
  const up = new Vector3(...parseDisplayUp([-2, 0, 0])!);
  const direction = explicitOrbitDirection(up);
  expect(up.toArray()).toEqual([-1, 0, 0]);
  expect(direction.dot(up)).toBeCloseTo(1);
  expect(direction.clone().projectOnPlane(up).length()).toBeCloseTo(Math.sqrt(13));
});

it("keeps a horizontal viewing direction when the preferred one is parallel to up", () => {
  const up = new Vector3(2, 0, 3).normalize();
  const direction = explicitOrbitDirection(up);
  expect(direction.dot(up)).toBeCloseTo(1);
  expect(direction.clone().projectOnPlane(up).length()).toBeCloseTo(Math.sqrt(13));
});
