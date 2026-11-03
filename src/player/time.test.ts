import { expect, test } from "vitest";
import { containingFrame, nearestFrame, seekSeconds } from "./time";
test("seeks inside irregular video frame intervals without mislabelling a previous frame", () => {
  const pts = [0, 32_000_000, 63_988_889, 100_000_000];
  const target = seekSeconds(pts, 2, 0.14);
  expect(target).toBeGreaterThan(pts[2] / 1e9);
  expect(target).toBeLessThan(pts[3] / 1e9);
  expect(containingFrame(pts, target)).toBe(2);
  expect(nearestFrame(pts, pts[2] / 1e9)).toBe(2);
  expect(containingFrame(pts, pts[2] / 1e9 - 0.000001)).toBe(1);
  expect(containingFrame(pts, seekSeconds(pts, 3, 0.14))).toBe(3);
});
