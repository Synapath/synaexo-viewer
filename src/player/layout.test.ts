import { expect, test } from "vitest";
import { viewColumns } from "./layout";
test("lays out one through six EXO views with or without the EGO view without dropping any tile", () => {
  for (let exo = 1; exo <= 6; exo++)
    for (const ego of [0, 1]) {
      const views = 1 + exo + ego,
        columns = viewColumns(views),
        rows = Math.ceil(views / columns);
      expect(columns).toBeGreaterThan(0);
      expect(columns).toBeLessThanOrEqual(4);
      expect(rows * columns).toBeGreaterThanOrEqual(views);
    }
  expect(viewColumns(6)).toBe(3);
  expect(viewColumns(8)).toBe(4);
});
