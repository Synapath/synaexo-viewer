import { Vector3 } from "three";
import { expect, it } from "vitest";
import { explicitOrbitDirection, parseDisplayUp } from "./orbitBasis";

it("frames an explicit Pico depth-camera up axis from slightly above", () => {
  const up = new Vector3(...parseDisplayUp([-2, 0, 0])!);
  const direction = explicitOrbitDirection(up);
  expect(up.toArray()).toEqual([-1, 0, 0]);
  expect(direction.dot(up)).toBeCloseTo(1);
  expect(direction.clone().projectOnPlane(up).length()).toBeCloseTo(Math.sqrt(13));
});

it("keeps the default viewing direction for Tracker's explicit +Y", () => {
  const direction = explicitOrbitDirection(new Vector3(0, 1, 0));
  expect(direction.x).toBeCloseTo(2);
  expect(direction.y).toBeCloseTo(1);
  expect(direction.z).toBeCloseTo(3);
});

it("keeps a horizontal viewing direction when the preferred one is parallel to up", () => {
  const up = new Vector3(2, 0, 3).normalize();
  const direction = explicitOrbitDirection(up);
  expect(direction.dot(up)).toBeCloseTo(1);
  expect(direction.clone().projectOnPlane(up).length()).toBeCloseTo(Math.sqrt(13));
});
