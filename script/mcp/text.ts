const ELLIPSIS = "…";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS);

type CodePointRange = [number, number];

function escapeCodePoint(codePoint: number): string {
  return `\\u{${codePoint.toString(16)}}`;
}

function characterClass(ranges: CodePointRange[]): string {
  return ranges
    .map(([from, to]) => (from === to ? escapeCodePoint(from) : `${escapeCodePoint(from)}-${escapeCodePoint(to)}`))
    .join("");
}

const INVISIBLE_RANGES: CodePointRange[] = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0x206a, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

const CONTROL_RANGES: CodePointRange[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
];

const INVISIBLE_CHARACTERS = new RegExp(`[${characterClass(INVISIBLE_RANGES)}]`, "gu");
const CONTROL_CHARACTERS = new RegExp(`[${characterClass(CONTROL_RANGES)}]+`, "gu");

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

export function truncateText(text: string, maxCodePoints: number, maxBytes: number = Number.POSITIVE_INFINITY): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxCodePoints && utf8Length(text) <= maxBytes) {
    return text;
  }
  const kept: string[] = [];
  let bytes = ELLIPSIS_BYTES;
  for (const codePoint of codePoints) {
    const size = utf8Length(codePoint);
    if (kept.length + 1 >= maxCodePoints || bytes + size > maxBytes) {
      break;
    }
    kept.push(codePoint);
    bytes += size;
  }
  return `${kept.join("").trimEnd()}${ELLIPSIS}`;
}

export function untrustedText(value: unknown, maxCodePoints: number, maxBytes?: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const flattened = value.replace(INVISIBLE_CHARACTERS, "").replace(CONTROL_CHARACTERS, " ").trim();
  return truncateText(flattened, maxCodePoints, maxBytes);
}

export function jsonByteLength(value: unknown): number {
  return utf8Length(JSON.stringify(value));
}

export function fitToByteBudget<T, R>(items: T[], maxBytes: number, build: (kept: T[], truncated: boolean) => R): R {
  let kept = items;
  let result = build(kept, false);
  while (jsonByteLength(result) > maxBytes && kept.length > 0) {
    kept = kept.slice(0, kept.length - 1);
    result = build(kept, true);
  }
  return result;
}
