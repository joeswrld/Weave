/**
 * Canonical byte encoding primitives for Weave.
 *
 * Every consensus-critical structure (transactions, block headers, blocks)
 * is hashed over the bytes these classes produce, so the encoding must be
 * byte-for-byte identical on every node and in every wallet. Rules:
 *
 *  - Fixed-width integers are little-endian (same as Bitcoin).
 *  - Variable-length data is prefixed with a "varint" (Bitcoin's CompactSize).
 *  - Varints MUST use the shortest possible encoding. The reader rejects
 *    non-canonical encodings, so two different byte strings can never decode
 *    to the same object (which would otherwise let someone mutate a txid
 *    without invalidating anything).
 *  - Decoding is strict: truncated input and trailing bytes are errors.
 *
 * No I/O and no environment-specific APIs: runs unchanged in Node and browsers.
 */

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

const MAX_U32 = 0xffff_ffff;
const MAX_U64 = (1n << 64n) - 1n;

export class ByteWriter {
  private parts: Uint8Array[] = [];
  private size = 0;

  get length(): number {
    return this.size;
  }

  writeBytes(bytes: Uint8Array): this {
    this.parts.push(bytes.slice()); // copy: later mutation by the caller can't change our output
    this.size += bytes.length;
    return this;
  }

  writeU8(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) {
      throw new RangeError(`u8 out of range: ${n}`);
    }
    return this.writeBytes(Uint8Array.of(n));
  }

  writeU32LE(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > MAX_U32) {
      throw new RangeError(`u32 out of range: ${n}`);
    }
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return this.writeBytes(b);
  }

  writeU64LE(n: bigint): this {
    if (typeof n !== "bigint" || n < 0n || n > MAX_U64) {
      throw new RangeError(`u64 out of range: ${String(n)}`);
    }
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return this.writeBytes(b);
  }

  /** Bitcoin CompactSize: 1, 3, 5 or 9 bytes, always the shortest form. */
  writeVarInt(n: number): this {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new RangeError(`varint out of range: ${n}`);
    }
    if (n < 0xfd) return this.writeU8(n);
    if (n <= 0xffff) {
      const b = new Uint8Array(3);
      b[0] = 0xfd;
      new DataView(b.buffer).setUint16(1, n, true);
      return this.writeBytes(b);
    }
    if (n <= MAX_U32) {
      const b = new Uint8Array(5);
      b[0] = 0xfe;
      new DataView(b.buffer).setUint32(1, n, true);
      return this.writeBytes(b);
    }
    const b = new Uint8Array(9);
    b[0] = 0xff;
    new DataView(b.buffer).setBigUint64(1, BigInt(n), true);
    return this.writeBytes(b);
  }

  /** varint length prefix followed by the raw bytes. */
  writeVarBytes(bytes: Uint8Array): this {
    this.writeVarInt(bytes.length);
    return this.writeBytes(bytes);
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

export class ByteReader {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (n < 0 || n > this.remaining) {
      throw new DecodeError("unexpected end of data");
    }
  }

  readBytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readU8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  private readU16LE(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readU32LE(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readU64LE(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** Reads a CompactSize varint; rejects non-shortest encodings. */
  readVarInt(): number {
    const tag = this.readU8();
    if (tag < 0xfd) return tag;
    if (tag === 0xfd) {
      const v = this.readU16LE();
      if (v < 0xfd) throw new DecodeError("non-canonical varint");
      return v;
    }
    if (tag === 0xfe) {
      const v = this.readU32LE();
      if (v <= 0xffff) throw new DecodeError("non-canonical varint");
      return v;
    }
    const v = this.readU64LE();
    if (v <= 0xffff_ffffn) throw new DecodeError("non-canonical varint");
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DecodeError("varint exceeds safe integer range");
    }
    return Number(v);
  }

  readVarBytes(): Uint8Array {
    return this.readBytes(this.readVarInt());
  }

  /** Call after decoding a complete object: trailing bytes are an error. */
  assertEnd(): void {
    if (this.remaining !== 0) {
      throw new DecodeError(`${this.remaining} trailing byte(s) after object`);
    }
  }
}