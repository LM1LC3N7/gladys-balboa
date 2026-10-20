// -----------------------------------------------------------------------------
// The hostile scenarios of review 1 (S1 to S8), turned into regression tests:
// stops at once, a repeated stop under a guard, statuses superseded within
// one chunk, a module changing its identity, the blower overlapping the
// circulation pump, "Ready" above the ceiling, the frame reader on hostile
// input, the reconnection cadence.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BalboaApp } from '../src/app.js';
import { SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { FrameReader } from '../src/balboa/frame.js';
import { HOST, MAC, NOW, fakeSpa, settle, spaFrame } from './helpers/fakeSpa.js';

const DEVICE = `ext:test-integration:balboa:${MAC}`;
const feature = (role) => `${DEVICE}:${role}`;
const TOGGLE = 0x11;

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map(String).join(' ')),
    ]),
  );

async function setup(t, { config = { address: HOST }, spa = fakeSpa(), logs = [] } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new BalboaApp({
    gladys,
    logger: recorder(logs),
    connect: spa.connect,
    now: () => Date.now(),
  });
  registerHandlers(gladys, app, recorder(logs));
  const advance = async (ms, step = 100) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      const delta = Math.min(step, ms - elapsed);
      t.mock.timers.tick(delta);
      spa.tick(delta);
      await settle();
    }
  };
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  await advance(2 * SECOND);
  for (const d of [...gladys.fake.discoveredDevices]) {
    await gladys.fake.deviceCreated(d);
  }
  await settle();
  const fire = (role, value) => {
    const d = gladys.fake.devices.find((x) => x.external_id === DEVICE);
    const target = d.features.find((f) => f.external_id === feature(role));
    return gladys.fake.setValue(d, target, value);
  };
  const command = async (role, value, { wait = 5 * SECOND } = {}) => {
    const ack = fire(role, value);
    await settle();
    await advance(wait);
    return ack;
  };
  return { gladys, app, spa, advance, logs, command, fire };
}

test('S1 four stops at once (a scene turning everything off): all sent, all done', async (t) => {
  const spa = fakeSpa();
  spa.pumps[0] = 1; // low: off is low -> high -> off, two presses
  spa.pumps[1] = 1;
  spa.lights[0] = 1;
  spa.heatMode = 0;
  const { fire, advance } = await setup(t, { spa });
  const acks = [
    fire('pump-1', 'off'),
    fire('pump-2', 'off'),
    fire('light-1', 0),
    fire('heat-mode', 'rest'),
  ];
  await settle();
  await advance(6 * SECOND);
  const results = await Promise.all(acks);
  assert.deepEqual(
    results.map((r) => [r.success, r.error ?? null]),
    [
      [true, null],
      [true, null],
      [true, null],
      [true, null],
    ],
  );
  assert.deepEqual(
    { pumps: spa.pumps.slice(0, 2), light: spa.lights[0], heatMode: spa.heatMode },
    { pumps: [0, 0], light: 0, heatMode: 1 },
  );
});

test('S1b a second stop on the same equipment waits for the first, then finds it done', async (t) => {
  const spa = fakeSpa();
  spa.pumps[1] = 1;
  const { fire, advance } = await setup(t, { spa });
  const first = fire('pump-2', 'off');
  await settle();
  const second = fire('pump-2', 'off');
  await settle();
  await advance(5 * SECOND);
  assert.equal((await first).success, true);
  assert.equal((await second).success, true);
  assert.deepEqual(spa.commands(), [[TOGGLE, 0x05]]);
});

test('S2 a refused command logs its role, never the MAC', async (t) => {
  const logs = [];
  const { command } = await setup(t, { logs });
  assert.equal((await command('target-temperature', 37)).success, false);
  assert.ok(logs.some((l) => l.startsWith('Command target-temperature refused')));
  assert.ok(logs.every((l) => !l.includes(MAC)));
});

test('S3 a °F status then a °C status in one chunk: decided on the latest, °C byte', async (t) => {
  const spa = fakeSpa({ celsius: false });
  const { fire, advance } = await setup(t, {
    spa,
    config: { address: HOST, allow_heating: true, max_temperature: 38 },
  });
  spa.quiet = true;
  const ack = fire('target-temperature', 37);
  await settle();
  const fahrenheit = spaFrame(0x13, [...spa.statusPayload()], [0xff, 0xaf]);
  spa.celsius = true;
  spa.target = 74;
  spa.temperature = 74;
  const celsius = spaFrame(0x13, [...spa.statusPayload()], [0xff, 0xaf]);
  spa.inject(Buffer.concat([fahrenheit, celsius]));
  await settle();
  spa.quiet = false;
  await advance(5 * SECOND);
  const result = await ack;
  // 37 °C is already set on the °C spa: nothing sent, never 99 (°F).
  assert.equal(result.success, true, result.error);
  assert.deepEqual(spa.commands(), []);
});

test('S3b "off" with "on" then "off" in one chunk: decided on the latest, no press', async (t) => {
  const spa = fakeSpa();
  spa.pumps[1] = 1;
  const { fire, advance } = await setup(t, { spa });
  spa.quiet = true;
  const ack = fire('pump-2', 'off');
  await settle();
  const on = spaFrame(0x13, [...spa.statusPayload()], [0xff, 0xaf]);
  spa.pumps[1] = 0;
  const off = spaFrame(0x13, [...spa.statusPayload()], [0xff, 0xaf]);
  spa.inject(Buffer.concat([on, off]));
  await settle();
  spa.quiet = false;
  await advance(5 * SECOND);
  assert.equal((await ack).success, true);
  assert.equal(spa.pumps[1], 0);
  assert.deepEqual(spa.commands(), []);
});

test('S3c a confirmation needs a status received after the frame', async (t) => {
  const spa = fakeSpa();
  const { fire, advance, app } = await setup(t, {
    spa,
    config: { address: HOST, allow_jets: true },
  });
  spa.ignore = true;
  const ack = fire('pump-2', 'on');
  await settle();
  await advance(5 * SECOND);
  assert.match((await ack).error, /sans confirmation/);
  // The guard is still there: no status after the press showed a change.
  assert.ok(app.guardActive(`${MAC}:pump-2`));
});

test('S4 "off" again while the first "off" is unconfirmed: never "success" without a frame', async (t) => {
  const spa = fakeSpa();
  spa.pumps[0] = 1;
  const { command } = await setup(t, { spa });
  spa.ignore = true;
  assert.match((await command('pump-1', 'off')).error, /sans confirmation/);
  const second = await command('pump-1', 'off');
  assert.equal(second.success, false);
  assert.match(second.error, /pas encore confirmée/);
  assert.equal(spa.commands().length, 1);
});

test('S4b a stop waits for the press in flight to show, then decides on the status after it', async (t) => {
  const spa = fakeSpa();
  const { gladys, fire, advance } = await setup(t, {
    spa,
    config: { address: HOST, allow_jets: true },
  });
  // "low" sent; a stop arrives before the spa showed the press.
  const start = fire('pump-1', 'low');
  await settle();
  await advance(1_100);
  await gladys.fake.configUpdated({ address: HOST });
  await settle();
  const stop = fire('pump-1', 'off');
  await settle();
  await advance(6 * SECOND);
  await start;
  assert.equal((await stop).success, true, (await stop).error);
  assert.equal(spa.pumps[0], 0);
});

test('S5 a module that changes its MAC on one connection is dropped, Discovery not flooded', async (t) => {
  const spa = fakeSpa();
  const { gladys, app, advance } = await setup(t, { spa });
  let publishes = 0;
  const original = gladys.publishDiscoveredDevices.bind(gladys);
  gladys.publishDiscoveredDevices = async (devices) => {
    publishes += 1;
    return original(devices);
  };
  let n = 0;
  for (let s = 0; s < 10; s += 1) {
    const chunk = [];
    for (let i = 0; i < 40; i += 1) {
      n += 1;
      const mac = Buffer.alloc(6);
      mac.writeUInt32BE(n, 2);
      chunk.push(spaFrame(0x94, [0x02, 0x14, 0x80, ...mac, ...Buffer.alloc(16, 0x11)]));
    }
    spa.inject(Buffer.concat(chunk));
    await settle(60);
    await advance(SECOND, 250);
  }
  assert.ok(publishes <= 5, `${publishes} publications`);
  assert.ok(app.seen.size <= 2, `${app.seen.size} spas remembered`);
  assert.equal(app.spa.mac, MAC);
});

test('S5b a configuration repeated many times a second: republished at most every 5 s', async (t) => {
  const spa = fakeSpa();
  const { gladys, advance } = await setup(t, { spa });
  let publishes = 0;
  const original = gladys.publishDiscoveredDevices.bind(gladys);
  gladys.publishDiscoveredDevices = async (devices) => {
    publishes += 1;
    return original(devices);
  };
  for (let s = 0; s < 10; s += 1) {
    const chunk = [];
    for (let i = 0; i < 40; i += 1) {
      const name = Buffer.from(`M${(s * 40 + i) % 1000}`.padEnd(8, ' '), 'latin1');
      chunk.push(spaFrame(0x24, [100, 201, 20, 0, ...name, 1, 0, 0, 0, 0, 1, 10, 0, 0]));
    }
    spa.inject(Buffer.concat(chunk));
    await settle(60);
    await advance(SECOND, 250);
  }
  assert.ok(publishes <= 3, `${publishes} publications`);
});

test('S6 frame reader: junk bounded, near-frames scanned linearly, frames every 4000 bytes kept', () => {
  const reader = new FrameReader();
  const big = Buffer.alloc(1 << 20, 0x40);
  for (let i = 0; i < big.length; i += 3) big[i] = 0x7e;
  reader.feed(big);
  assert.ok(reader.flooded);
  const r2 = new FrameReader();
  const good = spaFrame(0x13, [...Buffer.alloc(24)], [0xff, 0xaf]);
  const junk = Buffer.alloc(4000, 0x7e);
  const parts = [];
  for (let i = 0; i < 1000; i += 1) parts.push(junk, good);
  const stream = Buffer.concat(parts);
  let frames = 0;
  for (let i = 0; i < stream.length; i += 65536)
    frames += r2.feed(stream.subarray(i, i + 65536)).length;
  assert.equal(frames, 1000);
});

test('S7 a module that sends one frame then closes: reconnects with the backoff, no burst', async (t) => {
  const spa = fakeSpa();
  const { advance, app } = await setup(t, { spa });
  const original = spa.connect;
  app.connect = (opts) => {
    const socket = original(opts);
    setImmediate(() => setImmediate(() => socket.destroy()));
    return socket;
  };
  for (const s of spa.sockets) s.destroy();
  await settle();
  const before = spa.connects.length;
  await advance(120 * SECOND, SECOND);
  assert.ok(spa.connects.length - before <= 13, `${spa.connects.length - before} connections`);
});

test('S8 circulation pump and blower 1: the blower state is unknown, its commands refused', async (t) => {
  const spa = fakeSpa({ configuration: [0x01, 0x00, 0x01, 0x81, 0x00, 0x00] });
  spa.circulation = 1;
  const { gladys, command } = await setup(t, { spa });
  assert.equal(gladys.fake.lastState(feature('blower-1')), undefined);
  assert.equal(gladys.fake.lastState(feature('circulation-pump')), 1);
  const ack = await command('blower-1', 'off');
  assert.match(ack.error, /valeur actuelle/);
  assert.deepEqual(spa.commands(), []);
});

test('M2 "Ready" refused when the setpoint set on the spa is above the ceiling', async (t) => {
  const spa = fakeSpa();
  spa.heatMode = 1;
  spa.target = 79; // 39.5 °C, set at the panel
  const { command, gladys } = await setup(t, {
    spa,
    config: { address: HOST, allow_heating: true },
  });
  assert.match((await command('heat-mode', 'ready')).error, /dépasse le plafond/);
  assert.deepEqual(spa.commands(), []);
  await gladys.fake.configUpdated({ address: HOST, allow_heating: true, max_temperature: 40 });
  await settle();
  assert.equal((await command('heat-mode', 'ready')).success, true);
  assert.deepEqual(spa.commands(), [[TOGGLE, 0x51]]);
});
