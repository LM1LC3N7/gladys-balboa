// -----------------------------------------------------------------------------
// Balboa frames (ported from pybalboa 1.1.4, `utils.py` and `client.py`):
//
//   0x7E  L  b1 b2 type payload...  crc  0x7E
//
// `L` counts itself, the three header bytes, the payload and the checksum
// (so a frame is L + 2 bytes on the wire); `crc` is a CRC-8 (polynomial
// 0x07, initial value 0xB5, final xor 0x02) of `L` and the bytes after it.
//
// The protocol is not documented: the reader trusts nothing.
//   - a frame is bounded by its length byte, 5 to LIMITS.frameMaxLength (66
//     bytes at most on the wire), and the buffer never holds more than one
//     incomplete frame;
//   - a frame must start and end with 0x7E and carry the right checksum,
//     otherwise its first byte is dropped and the scan goes on (linear: each
//     start byte is tried once, over at most 64 bytes);
//   - LIMITS.junkBytes dropped since the last valid frame: the stream is not
//     a Balboa spa, the caller drops the connection.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

export const DELIMITER = 0x7e;
/** The two header bytes of a frame sent to the spa (pybalboa MESSAGE_SEND). */
const SEND_HEADER = [0x0a, 0xbf];

/** The CRC-8 of pybalboa `calculate_checksum`. */
export function checksum(bytes) {
  let crc = 0xb5;
  for (const cur of bytes) {
    for (let i = 0; i < 8; i += 1) {
      const bit = crc & 0x80;
      crc = ((crc << 1) & 0xff) | ((cur >> (7 - i)) & 0x01);
      if (bit) {
        crc ^= 0x07;
      }
    }
  }
  for (let i = 0; i < 8; i += 1) {
    const bit = crc & 0x80;
    crc = (crc << 1) & 0xff;
    if (bit) {
      crc ^= 0x07;
    }
  }
  return crc ^ 0x02;
}

const isByte = (value) => Number.isInteger(value) && value >= 0 && value <= 0xff;

/** The frame of a message to the spa: `type` and its payload bytes. */
export function encode(type, payload = []) {
  if (!isByte(type) || !Array.isArray(payload) || !payload.every(isByte)) {
    throw new RangeError('Invalid Balboa message');
  }
  const body = [...SEND_HEADER, type, ...payload];
  const length = body.length + 2;
  if (length > 0xff) {
    throw new RangeError('Balboa message too long');
  }
  const head = [length, ...body];
  return Buffer.from([DELIMITER, ...head, checksum(head), DELIMITER]);
}

/**
 * Splits the received bytes into checked frames. `feed(chunk)` returns the
 * frames it completed, each `{ type, payload }` (payload: a Buffer copy).
 */
export class FrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
    /** Bytes dropped since the last valid frame. */
    this.junk = 0;
  }

  get flooded() {
    return this.junk > LIMITS.junkBytes;
  }

  feed(chunk) {
    const frames = [];
    const buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    let at = 0;
    while (at < buffer.length) {
      if (this.flooded) {
        // Not a spa: the rest is not even scanned (the caller drops the connection).
        this.buffer = Buffer.alloc(0);
        return frames;
      }
      const start = buffer.indexOf(DELIMITER, at);
      if (start === -1) {
        this.junk += buffer.length - at;
        at = buffer.length;
        break;
      }
      this.junk += start - at;
      at = start;
      if (at + 1 >= buffer.length) {
        break;
      }
      const length = buffer[at + 1];
      if (length < LIMITS.frameMinLength || length > LIMITS.frameMaxLength) {
        // Not a length (two delimiters in a row: the end of a frame and the
        // start of the next one): the first byte goes.
        this.junk += 1;
        at += 1;
        continue;
      }
      const end = at + 1 + length;
      if (end >= buffer.length) {
        // Incomplete: kept for the next chunk (66 bytes at most).
        break;
      }
      const body = buffer.subarray(at + 1, end - 1);
      if (buffer[end] !== DELIMITER || checksum(body) !== buffer[end - 1]) {
        this.junk += 1;
        at += 1;
        continue;
      }
      frames.push({ type: body[3], payload: Buffer.from(body.subarray(4)) });
      this.junk = 0;
      at = end + 1;
    }
    this.buffer = Buffer.from(buffer.subarray(at));
    return frames;
  }
}
