import { expect, test } from "vitest";
import { parseNpy } from "../../core/npy";
function npy(
  dtype: string,
  shape: number[],
  payload: Uint8Array,
  fortran = false,
) {
  const header = new TextEncoder().encode(
    `{'descr': '${dtype}', 'fortran_order': ${fortran ? "True" : "False"}, 'shape': (${shape.join(",")}${shape.length === 1 ? "," : ""}), }\n`,
  );
  const bytes = new Uint8Array(10 + header.length + payload.length);
  bytes.set([147, 78, 85, 77, 80, 89, 1, 0]);
  new DataView(bytes.buffer).setUint16(8, header.length, true);
  bytes.set(header, 10);
  bytes.set(payload, 10 + header.length);
  return bytes;
}
test("keeps nanosecond int64 evidence beyond the low 32 bits exact and rejects unsafe integers", () => {
  const bytes = new Uint8Array(16),
    view = new DataView(bytes.buffer);
  view.setBigInt64(0, 2n ** 40n + 123n, true);
  view.setBigInt64(8, -1n, true);
  expect([...parseNpy(npy("<i8", [2], bytes)).data]).toEqual([
    2 ** 40 + 123,
    -1,
  ]);
  view.setBigInt64(0, 2n ** 53n + 1n, true);
  expect(() => parseNpy(npy("<i8", [2], bytes))).toThrow("超出精确范围");
});
test("restores Fortran column-major shape bases to row-major and rejects truncated payloads", () => {
  const bytes = new Uint8Array(new Float32Array([1, 4, 2, 5, 3, 6]).buffer);
  expect([...parseNpy(npy("<f4", [2, 3], bytes, true)).data]).toEqual([
    1, 2, 3, 4, 5, 6,
  ]);
  expect(() => parseNpy(npy("<f4", [2, 3], bytes.slice(0, -1), true))).toThrow(
    "长度无效",
  );
});

test("keeps double precision calibration values and exact absolute int64 clocks", () => {
  const value = 12345.123456789;
  expect(parseNpy(npy("<f8", [1], new Uint8Array(new Float64Array([value]).buffer))).data[0]).toBe(value);
  const exact = new BigInt64Array([2n**60n+123n,2n**60n+33_333_456n]);
  expect(parseNpy(npy("<i8", [2], new Uint8Array(exact.buffer)), true).int64).toEqual(exact);
});
