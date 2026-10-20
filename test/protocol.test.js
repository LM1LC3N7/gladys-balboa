// -----------------------------------------------------------------------------
// The frames and messages, against the captures shipped with pybalboa 1.1.4
// (`tests/fixtures/*.json`: the bytes between the delimiters, length byte
// first, checksum last) and hostile input.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameReader, checksum, encode } from '../src/balboa/frame.js';
import {
  fields,
  parseDeviceConfiguration,
  parseModuleIdentification,
  parseSetupParameters,
  parseStatus,
  parseSystemInformation,
  speedOf,
  toCelsius,
} from '../src/balboa/protocol.js';

/** pybalboa fixtures: bp501g1 (°F) and bfbp20s. */
const BP501G1 = {
  module_identification: '1e0abf94021480001527735be20000000000000000001527ffff735be26f',
  system_information: '1a0abf2464c91400425035303147312001129058ff01060400e7',
  setup_parameters: '0e0abf2506013263506809034163',
  device_configuration: '0b0abf2e060001100000d2',
  filter_cycle: '0d0abf23170002000800000fda',
  status_update: '1dffaf13000066130600005a00000c0900000000000000006600000005',
};
const BFBP20S = {
  module_identification: '1e0abf9402148000152771f19a0000000000000000001527ffff71f19a0a',
  system_information: '1a0abf2464dc24004246425032305320035cd4ccd7010a0000de',
  setup_parameters: '0e0abf25040332635068e901454f',
  device_configuration: '0b0abf2e020005d00068bc',
  status_update: '1dffaf130003640a3700040100021c00000203000000012068000452f8',
};

const wire = (hex) => Buffer.from(`7e${hex}7e`, 'hex');
const payloadOf = (hex) => Buffer.from(hex, 'hex').subarray(4, -1);

test('the checksum of every pybalboa capture, and of pybalboa test_utils', () => {
  for (const hex of [...Object.values(BP501G1), ...Object.values(BFBP20S)]) {
    const bytes = Buffer.from(hex, 'hex');
    assert.equal(checksum(bytes.subarray(0, -1)), bytes.at(-1), hex);
  }
  const value = Buffer.from('1DFFAF13000064082D0000010000040000000000000000006400000006', 'hex');
  assert.equal(checksum(value.subarray(0, -1)), value.at(-1));
});

test('encode: the "device present" and request frames pybalboa sends', () => {
  assert.equal(encode(0x04).toString('hex'), '7e050abf04777e');
  const request = encode(0x22, [0x00, 0x00, 0x01]);
  assert.equal(request[0], 0x7e);
  assert.equal(request[1], 8);
  assert.equal(request.at(-1), 0x7e);
  assert.equal(checksum(request.subarray(1, -2)), request.at(-2));
  assert.throws(() => encode(0x11, [256]), RangeError);
  assert.throws(() => encode(0x11, [-1]), RangeError);
  assert.throws(() => encode(0x11, ['1']), RangeError);
  assert.throws(() => encode(0x11, new Array(260).fill(0)), RangeError);
});

test('the reader: whole captures, split anywhere, glued together', () => {
  const stream = Buffer.concat(Object.values(BP501G1).map(wire));
  for (let cut = 1; cut < stream.length; cut += 7) {
    const reader = new FrameReader();
    const frames = [...reader.feed(stream.subarray(0, cut)), ...reader.feed(stream.subarray(cut))];
    assert.deepEqual(
      frames.map((f) => f.type),
      [0x94, 0x24, 0x25, 0x2e, 0x23, 0x13],
      `cut at ${cut}`,
    );
    assert.equal(reader.junk, 0);
  }
});

test('the reader: bad checksum, wrong end, garbage and short lengths are skipped', () => {
  const reader = new FrameReader();
  const good = wire(BP501G1.status_update);
  const badCrc = Buffer.from(good);
  badCrc[badCrc.length - 2] ^= 0xff;
  const badEnd = Buffer.from(good);
  badEnd[badEnd.length - 1] = 0x00;
  const frames = reader.feed(
    Buffer.concat([
      Buffer.from([0x00, 0x7e, 0x02, 0x7e, 0x00, 0x01]),
      badCrc,
      badEnd,
      Buffer.from('garbage'),
      good,
    ]),
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 0x13);
  assert.equal(reader.junk, 0);
});

test('the reader: a delimiter is never a length, a length above 64 is not a frame', () => {
  const reader = new FrameReader();
  const good = wire(BP501G1.status_update);
  // The end of a bad frame, then the start of a good one.
  assert.equal(reader.feed(Buffer.concat([Buffer.from([0x7e, 0x7e]), good])).length, 1);
  assert.equal(reader.feed(Buffer.concat([Buffer.from([0x7e, 0x41, 0x00]), good])).length, 1);
  // A stray delimiter with a plausible length only delays the next frames.
  assert.equal(reader.feed(Buffer.concat([Buffer.from([0x7e, 0x40]), good])).length, 0);
  assert.ok(reader.buffer.length <= 66);
  const frames = [...reader.feed(good), ...reader.feed(good)];
  assert.ok(frames.length >= 1 && frames.every((f) => f.type === 0x13));
});

test('the reader: bounded buffer, a flood is detected and not scanned', () => {
  const reader = new FrameReader();
  // A frame announcing 64 bytes that never come: kept, 66 bytes at most.
  reader.feed(Buffer.from([0x7e, 0x40, 1, 2, 3]));
  assert.ok(reader.buffer.length <= 66);
  reader.feed(Buffer.alloc(300, 0x01));
  assert.ok(reader.buffer.length <= 66);
  assert.ok(!reader.flooded);
  const frames = reader.feed(Buffer.alloc(10_000, 0x41));
  assert.equal(frames.length, 0);
  assert.ok(reader.flooded);
  assert.equal(reader.buffer.length, 0);
});

test('fields: pybalboa byte_parser examples', () => {
  const byte = 0b01010101;
  assert.deepEqual(fields(byte), [1, 0, 1, 0, 1, 0, 1, 0]);
  assert.deepEqual(fields(byte, { offset: 1, count: 3 }), [0, 1, 0]);
  assert.deepEqual(fields(byte, { count: 2, bits: 2 }), [1, 1]);
  assert.deepEqual(fields(byte, { offset: 1, count: 2, bits: 2 }), [2, 2]);
  assert.deepEqual(fields(byte, { count: 3, bits: 3 }), [5, 2, 1]);
});

test('status update of a BP501G1 (°F)', () => {
  const s = parseStatus(payloadOf(BP501G1.status_update));
  assert.equal(s.celsius, false);
  assert.equal(s.state, 'running');
  assert.equal(s.temperature, 38.9);
  assert.equal(s.target, 38.9);
  assert.equal(s.raw.target, 0x66);
  assert.equal(s.heatMode, 'ready');
  assert.equal(s.range, 'high');
  assert.equal(s.heatState, 'off');
  assert.deepEqual(s.pumps, [1, 2, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(s.lights, [0, 0, 0, 0]);
  assert.equal(s.wifi, 'ok');
});

test('status update of a BFBP20S', () => {
  const s = parseStatus(payloadOf(BFBP20S.status_update));
  assert.equal(s.state, 'running');
  assert.equal(s.celsius, false);
  assert.equal(s.temperature, 37.8);
  assert.equal(s.target, 40);
  assert.equal(s.raw.target, 104);
  assert.equal(s.heatMode, 'ready');
  assert.equal(s.circulation, 1);
  assert.deepEqual(s.pumps.slice(0, 2), [0, 0]);
});

test('status: unknown temperature, short payload, unknown state', () => {
  const payload = Buffer.alloc(24);
  payload[0] = 0x42;
  payload[2] = 0xff;
  payload[9] = 1;
  payload[20] = 76;
  const s = parseStatus(payload);
  assert.equal(s.state, 'unknown');
  assert.equal(s.temperature, undefined);
  assert.equal(s.target, 38);
  assert.equal(parseStatus(Buffer.alloc(23)), undefined);
  assert.equal(parseStatus('x'.repeat(24)), undefined);
});

test('module identification, system information, setup parameters', () => {
  assert.deepEqual(parseModuleIdentification(payloadOf(BP501G1.module_identification)), {
    mac: '001527735be2',
  });
  assert.deepEqual(parseSystemInformation(payloadOf(BP501G1.system_information)), {
    model: 'BP501G1',
    version: 'M100_201 V20.0',
  });
  assert.deepEqual(parseSetupParameters(payloadOf(BP501G1.setup_parameters)), {
    low: { min: 50, max: 99 },
    high: { min: 80, max: 104 },
  });
  assert.equal(parseModuleIdentification(Buffer.alloc(24)), undefined);
  assert.equal(parseSystemInformation(Buffer.alloc(20)), undefined);
  // Control characters never reach a name.
  const info = Buffer.alloc(21);
  info.write('<b>\u0001x', 4, 'latin1');
  assert.equal(parseSystemInformation(info).model, 'bx');
});

test('device configuration: pumps with their speeds, lights, circulation', () => {
  assert.deepEqual(parseDeviceConfiguration(payloadOf(BP501G1.device_configuration)), {
    pumps: [
      { index: 0, states: 3 },
      { index: 1, states: 2 },
    ],
    lights: [{ index: 0, states: 2 }],
    circulation: false,
    blowers: [],
    aux: [],
    misters: [],
  });
  const bfbp = parseDeviceConfiguration(payloadOf(BFBP20S.device_configuration));
  assert.deepEqual(bfbp.pumps, [{ index: 0, states: 3 }]);
  assert.equal(bfbp.circulation, true);
  assert.equal(parseDeviceConfiguration(Buffer.alloc(5)), undefined);
});

test('speeds and conversions', () => {
  assert.equal(speedOf(0, 3), 'off');
  assert.equal(speedOf(2, 3), 'high');
  assert.equal(speedOf(2, 2), 'on', 'a value beyond the states is the last one');
  assert.equal(speedOf(undefined, 3), undefined);
  assert.equal(speedOf(1, 7), undefined);
  assert.equal(toCelsius(104), 40);
  assert.equal(toCelsius(80), 26.5);
  assert.equal(toCelsius(50), 10);
});
