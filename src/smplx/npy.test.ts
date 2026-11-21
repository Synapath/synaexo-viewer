import { expect, test } from "vitest";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { parseNpy, parseNpz } from "./npy";
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

test("keeps double precision calibration and the absolute int64 reference clock", () => {
  const calibration = 12345.123456789;
  const floats = new Uint8Array(new Float64Array([calibration]).buffer);
  expect(parseNpy(npy("<f8", [1], floats)).data[0]).toBe(calibration);
  const exact = new BigInt64Array([2n ** 60n + 123n, 2n ** 60n + 33_333_456n]);
  const clock = npy("<i8", [2], new Uint8Array(exact.buffer));
  expect(parseNpy(clock, true).int64).toEqual(exact);
  expect(() => parseNpy(clock)).toThrow("超出精确范围");
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

test.each(["<i2", ">i2", "<u2", ">u2"])("reads %s integer boundaries and zero with an unaligned byte offset", (dtype) => {
  const values = dtype[1] === "i" ? [-32768, -1, 0, 1, 32767] : [0, 1, 32768, 65535];
  const payload = new Uint8Array(values.length * 2);
  const view = new DataView(payload.buffer);
  values.forEach((value, i) => {
    if (dtype[1] === "i") view.setInt16(i * 2, value, dtype[0] === "<");
    else view.setUint16(i * 2, value, dtype[0] === "<");
  });
  const bytes = npy(dtype, [values.length], payload);
  const padded = new Uint8Array(bytes.length + 1);
  padded.set(bytes, 1);
  expect([...parseNpy(padded.subarray(1)).data]).toEqual(values);
  expect(() => parseNpy(bytes.subarray(0, bytes.length - 1))).toThrow("长度无效");
});

test("loads an NPZ with 6142 int16 view counts and preserves all 178 missing frames", async () => {
  const counts = new Int16Array(6142).fill(3);
  counts.fill(0, 123, 301);
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("body_view_count.npy", new Uint8ArrayReader(npy("<i2", [6142], new Uint8Array(counts.buffer))));
  const arrays = await parseNpz(await writer.close());
  expect(arrays.body_view_count.shape).toEqual([6142]);
  expect([...arrays.body_view_count.data]).toEqual([...counts]);
  expect([...arrays.body_view_count.data].filter(value => value === 0)).toHaveLength(178);
});
