import { BlobReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";

export type NumericArray =
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array;
export type NdArray = {
  dtype: string;
  shape: number[];
  fortranOrder: boolean;
  data: NumericArray | string[];
  /** Exact clock values; consumers must subtract the origin before conversion. */
  int64?: BigInt64Array | BigUint64Array;
};
const LIMIT = 256 * 1024 ** 2;

export function parseNpy(bytes: Uint8Array, preserveClock = false): NdArray {
  if (
    bytes.length < 12 ||
    ![147, 78, 85, 77, 80, 89].every((value, index) => bytes[index] === value)
  )
    throw new Error("NPY 文件标识无效");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    version = bytes[6];
  if (![1, 2, 3].includes(version)) throw new Error("NPY 格式版本不支持");
  const start = version === 1 ? 10 : 12,
    length = version === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  if (length > 65536 || start + length > bytes.length)
    throw new Error("NPY 头部不完整");
  const header = new TextDecoder().decode(
    bytes.subarray(start, start + length),
  );
  const dtype = header.match(/['"]descr['"]\s*:\s*['"]([^'"]+)['"]/)?.[1];
  const dimensions = header.match(/['"]shape['"]\s*:\s*\(([^)]*)\)/)?.[1];
  const order = header.match(/['"]fortran_order['"]\s*:\s*(True|False)/)?.[1];
  if (!dtype || dimensions === undefined || !order)
    throw new Error("NPY 数组头部无效");
  const shape = dimensions
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  if (
    shape.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    !Number.isSafeInteger(count) ||
    count > LIMIT / 4
  )
    throw new Error("NPY 数组维度超出预算");
  const type = dtype.match(/^([<>=|])([fiubUS])(\d+)$/);
  if (!type) throw new Error(`不支持 NPY 数据类型 ${dtype}`);
  const [, endian, kind, widthText] = type,
    width = Number(widthText),
    stride = width * (kind === "U" ? 4 : 1);
  const offset = start + length,
    payload = bytes.length - offset;
  if (
    !Number.isSafeInteger(stride) ||
    stride < 1 ||
    count * stride !== payload ||
    payload > LIMIT
  )
    throw new Error("NPY 数组长度无效");
  const little = endian !== ">",
    dataView = new DataView(bytes.buffer, bytes.byteOffset + offset, payload);
  let data: NumericArray | string[];
  let int64: BigInt64Array | BigUint64Array | undefined;
  if (kind === "U" || kind === "S") {
    data = Array.from({ length: count }, (_, i) => {
      let s = "";
      for (let j = 0; j < width; j++) {
        const code =
          kind === "U"
            ? dataView.getUint32(i * stride + j * 4, little)
            : dataView.getUint8(i * stride + j);
        if (code) s += String.fromCodePoint(code);
      }
      return s;
    });
  } else {
    if (
      !(
        (kind === "f" && [4, 8].includes(width)) ||
        (["i", "u"].includes(kind) && [1, 4, 8].includes(width)) ||
        (kind === "b" && width === 1)
      )
    )
      throw new Error(`不支持 NPY 数据类型 ${dtype}`);
    data =
      kind === "f"
        ? (width === 8 ? new Float64Array(count) : new Float32Array(count))
        : width === 8
          ? new Float64Array(count)
          : kind === "u"
            ? new Uint32Array(count)
            : new Int32Array(count);
    if (preserveClock && ["i", "u"].includes(kind) && width === 8) {
      if (shape.length !== 1) throw new Error("精确时间轴必须是一维数组");
      int64 = kind === "u" ? new BigUint64Array(count) : new BigInt64Array(count);
    }
    for (let i = 0; i < count; i++) {
      const at = i * stride;
      let n: number;
      if (kind === "f")
        n =
          width === 4
            ? dataView.getFloat32(at, little)
            : dataView.getFloat64(at, little);
      else if (width === 8) {
        const exact = kind === "u" ? dataView.getBigUint64(at, little) : dataView.getBigInt64(at, little);
        if (int64) int64[i] = exact;
        n = Number(exact);
        if (!int64 && !Number.isSafeInteger(n))
          throw new Error("NPY 64 位整数超出精确范围；时间证据不能截断");
      } else
        n =
          width === 1
            ? kind === "i"
              ? dataView.getInt8(at)
              : dataView.getUint8(at)
            : kind === "u"
              ? dataView.getUint32(at, little)
              : dataView.getInt32(at, little);
      data[i] = n;
    }
  }
  if (order === "True" && shape.length > 1) {
    const source = data,
      target = Array.isArray(source)
        ? new Array<string>(count)
        : new (source.constructor as new (n: number) => NumericArray)(count);
    const fStride: number[] = [];
    let product = 1;
    for (const n of shape) {
      fStride.push(product);
      product *= n;
    }
    for (let i = 0; i < count; i++) {
      let rem = i,
        f = 0;
      for (let k = shape.length - 1; k >= 0; k--) {
        const index = rem % shape[k];
        rem = Math.floor(rem / shape[k]);
        f += index * fStride[k];
      }
      if (Array.isArray(target)) target[i] = (source as string[])[f];
      else target[i] = (source as NumericArray)[f];
    }
    data = target;
  }
  return { dtype, shape, fortranOrder: false, data, ...(int64 ? { int64 } : {}) };
}

export async function parseNpz(
  bytes: Uint8Array,
  keys?: ReadonlySet<string>,
): Promise<Record<string, NdArray>> {
  const reader = new ZipReader(
      new BlobReader(new Blob([bytes as Uint8Array<ArrayBuffer>])),
    ),
    out: Record<string, NdArray> = Object.create(null);
  let expanded = 0,
    count = 0;
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (++count > 256) throw new Error("NPZ 数组数量超出预算");
      if (entry.directory) continue;
      if (entry.encrypted || !/^[-\w]+\.npy$/.test(entry.filename))
        throw new Error("NPZ 数组路径无效");
      const key = entry.filename.slice(0, -4);
      if (keys && !keys.has(key)) continue;
      expanded += entry.uncompressedSize;
      if (
        !Number.isSafeInteger(expanded) ||
        expanded > LIMIT ||
        Object.hasOwn(out, key)
      )
        throw new Error("NPZ 数组大小或名称无效");
      try {
        out[key] = parseNpy(
          await entry.getData(new Uint8ArrayWriter(), { checkCrc32: true }),
          key === "reference_timestamps_ns",
        );
      } catch (error) {
        throw new Error(`${key}: ${(error as Error).message}`);
      }
    }
    return out;
  } finally {
    await reader.close();
  }
}
