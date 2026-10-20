// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake spa behind the socket factory. Timers and Date are
// mocked: the tests move the clock (and the spa streams its status).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BalboaApp } from '../src/app.js';
import { ACTIONS, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { HOST, MAC, NOW, fakeSpa, settle } from './helpers/fakeSpa.js';

const CONFIG = { address: HOST };
const HEATING = { address: HOST, allow_heating: true };
const JETS = { address: HOST, allow_jets: true };
const DEVICE = `ext:test-integration:balboa:${MAC}`;
const feature = (role) => `${DEVICE}:${role}`;
const TOGGLE = 0x11;
const SET_TEMPERATURE = 0x20;

async function setup(t, { config = CONFIG, spa = fakeSpa(), create = true, logs = [] } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new BalboaApp({
    gladys,
    logger: recorder(logs),
    connect: spa.connect,
    now: () => Date.now(),
  });
  registerHandlers(gladys, app);
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
  // The first statuses.
  await advance(2 * SECOND);
  if (create) {
    for (const d of [...gladys.fake.discoveredDevices]) {
      await gladys.fake.deviceCreated(d);
    }
    await settle();
  }
  /** A command on a feature of the created device; resolves with the ack. */
  const command = async (role, value, { wait = 5 * SECOND } = {}) => {
    const d = gladys.fake.devices.find((x) => x.external_id === DEVICE);
    const target = d.features.find((f) => f.external_id === feature(role));
    const ack = gladys.fake.setValue(d, target, value);
    await settle();
    await advance(wait);
    return ack;
  };
  return { gladys, app, spa, advance, logs, command };
}

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role) => gladys.fake.lastState(feature(role));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const discovered = (gladys) => gladys.fake.discoveredDevices.find((d) => d.external_id === DEVICE);
const roles = (d) => d.features.map((f) => f.external_id.slice(d.external_id.length + 1));
const transportOf = (gladys) =>
  gladys.fake.transports.filter((x) => x.device_external_id === DEVICE).at(-1)?.transport;

test('without an address, the status asks for it and nothing is opened', async (t) => {
  const spa = fakeSpa();
  const { gladys } = await setup(t, { config: {}, spa });
  assert.equal(spa.connects.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP du module Wi-Fi/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(spa.connects.length, 0);
});

test('connects on port 4257 and asks what the spa is, then shows it connected', async (t) => {
  const spa = fakeSpa();
  const { gladys } = await setup(t, { spa, create: false });
  assert.deepEqual(spa.connects, [{ host: HOST, port: 4257 }]);
  assert.deepEqual(
    spa.received.slice(0, 4).map((f) => [f.type, ...f.payload]),
    [[0x04], [0x22, 0x02, 0x00, 0x00], [0x22, 0x04, 0x00, 0x00], [0x22, 0x00, 0x00, 0x01]],
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /Connecté : Balboa BP501G1/);
  assert.equal(spa.commands().length, 0, 'nothing but requests');
});

test('one device: its features, no switch, pumps and heat mode as lists', async (t) => {
  const { gladys } = await setup(t, { create: false });
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  const d = discovered(gladys);
  assert.equal(d.name, 'Spa Balboa');
  assert.equal(d.model, 'Balboa BP501G1');
  assert.equal(d.should_poll, false);
  assert.deepEqual(roles(d), [
    'water-temperature',
    'target-temperature',
    'heating',
    'heat-mode',
    'status',
    'temperature-range',
    'filter-cycle-1',
    'filter-cycle-2',
    'circulation-pump',
    'pump-1',
    'pump-2',
    'light-1',
  ]);
  const shape = Object.fromEntries(
    d.features.map((f) => [
      f.external_id.slice(d.external_id.length + 1),
      [f.category, f.type, f.unit ?? null, f.read_only, f.min, f.max],
    ]),
  );
  assert.deepEqual(shape['water-temperature'], [
    'temperature-sensor',
    'probe',
    'celsius',
    true,
    -20,
    80,
  ]);
  assert.deepEqual(shape['target-temperature'], [
    'thermostat',
    'target-temperature',
    'celsius',
    false,
    10,
    40,
  ]);
  assert.deepEqual(shape['heat-mode'], ['text', 'select', null, false, 0, 0]);
  assert.deepEqual(shape['pump-1'], ['text', 'select', null, false, 0, 0]);
  assert.deepEqual(shape.heating, ['unknown', 'binary', null, true, 0, 1]);
  assert.deepEqual(shape['circulation-pump'], ['unknown', 'binary', null, true, 0, 1]);
  assert.deepEqual(shape['light-1'], ['light', 'binary', null, false, 0, 1]);
  assert.ok(d.features.every((f) => f.category !== 'switch'));
  // Only a light may be a writable binary.
  assert.ok(
    d.features
      .filter((f) => !f.read_only && f.type === 'binary')
      .every((f) => f.category === 'light'),
  );
  const options = (role) =>
    d.features.find((f) => f.external_id === feature(role)).supported_options.map((o) => o.value);
  assert.deepEqual(options('pump-1'), ['off', 'low', 'high']);
  assert.deepEqual(options('pump-2'), ['off', 'on']);
  assert.deepEqual(options('heat-mode'), ['ready', 'rest']);
});

test('the values of the created device, badge local', async (t) => {
  const { gladys } = await setup(t);
  assert.equal(last(gladys, 'water-temperature'), 37);
  assert.equal(last(gladys, 'target-temperature'), 38);
  assert.equal(last(gladys, 'heating'), 1);
  assert.equal(last(gladys, 'heat-mode'), 'ready');
  assert.equal(last(gladys, 'status'), 'En marche (prêt, chauffe)');
  assert.equal(last(gladys, 'temperature-range'), 'Haute');
  assert.equal(last(gladys, 'filter-cycle-1'), 1);
  assert.equal(last(gladys, 'filter-cycle-2'), 0);
  assert.equal(last(gladys, 'pump-1'), 'off');
  assert.equal(last(gladys, 'light-1'), 0);
  assert.equal(last(gladys, 'circulation-pump'), 1);
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.LOCAL);
});

test('a spa in °F is shown in °C', async (t) => {
  const spa = fakeSpa({ celsius: false });
  const { gladys } = await setup(t, { spa });
  assert.equal(last(gladys, 'water-temperature'), 37.2);
  assert.equal(last(gladys, 'target-temperature'), 37.8);
});

test('the water temperature is sent at most every 10 s, the rest at once', async (t) => {
  const { gladys, spa, advance } = await setup(t);
  spa.temperature = 75;
  spa.lights[0] = 1;
  await advance(1_500);
  assert.equal(last(gladys, 'light-1'), 1);
  assert.equal(last(gladys, 'water-temperature'), 37);
  await advance(15 * SECOND);
  assert.equal(last(gladys, 'water-temperature'), 37.5);
});

// --- Heating ----------------------------------------------------------------

test('heating commands are off by default: nothing sent', async (t) => {
  const { spa, command } = await setup(t);
  const ack = await command('target-temperature', 37);
  assert.equal(ack.success, false);
  assert.match(ack.error, /commandes de chauffage sont désactivées/);
  assert.match((await command('heat-mode', 'ready')).error, /désactivées/);
  assert.deepEqual(spa.commands(), []);
});

test('the setpoint, allowed: sent in half degrees, confirmed by a status', async (t) => {
  const { gladys, spa, command } = await setup(t, { config: HEATING });
  const ack = await command('target-temperature', 37.5);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(spa.commands(), [[SET_TEMPERATURE, 75]]);
  assert.equal(last(gladys, 'target-temperature'), 37.5);
  // Already so: nothing sent.
  assert.equal((await command('target-temperature', '37.5')).success, true);
  assert.equal(spa.commands().length, 1);
});

test('the setpoint ceiling: 38 °C by default, never above 40 °C, strict values', async (t) => {
  const { spa, command, gladys } = await setup(t, { config: HEATING });
  assert.match((await command('target-temperature', 38.5)).error, /plafonnée à 38 °C/);
  assert.match((await command('target-temperature', 41)).error, /plafonnée/);
  for (const bad of ['', null, 'abc', '1e2', true, Number.NaN]) {
    assert.equal((await command('target-temperature', bad)).success, false, String(bad));
  }
  assert.match((await command('target-temperature', 37.3)).error, /multiple de 0,5 °C/);
  assert.match((await command('target-temperature', 5)).error, /entre 10 et 38/);
  assert.deepEqual(spa.commands(), []);
  await gladys.fake.configUpdated({ ...HEATING, max_temperature: 99 });
  await settle();
  assert.match((await command('target-temperature', 40.5)).error, /plafonnée à 40 °C/);
  assert.equal((await command('target-temperature', 40)).success, true);
  assert.deepEqual(spa.commands(), [[SET_TEMPERATURE, 80]]);
});

test('a °F spa: the setpoint converted, the ceiling kept', async (t) => {
  const spa = fakeSpa({ celsius: false });
  const { command } = await setup(t, { spa, config: { ...HEATING, max_temperature: 40 } });
  assert.equal((await command('target-temperature', 39)).success, true);
  assert.deepEqual(spa.commands(), [[SET_TEMPERATURE, 102]]);
  assert.equal((await command('target-temperature', 40)).success, true);
  assert.deepEqual(spa.commands().at(-1), [SET_TEMPERATURE, 104]);
});

test('the ceiling lowered while the command waits for a status: not sent', async (t) => {
  const { gladys, spa, advance } = await setup(t, { config: HEATING });
  const d = gladys.fake.devices.find((x) => x.external_id === DEVICE);
  const target = d.features.find((f) => f.external_id === feature('target-temperature'));
  const ack = gladys.fake.setValue(d, target, 37);
  await settle();
  await gladys.fake.configUpdated({ ...HEATING, max_temperature: 36 });
  await settle();
  await advance(5 * SECOND);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /plafonnée à 36 °C/);
  assert.deepEqual(spa.commands(), []);
});

test('the heating option turned off while waiting: not sent', async (t) => {
  const { gladys, spa, advance } = await setup(t, { config: HEATING });
  const d = gladys.fake.devices.find((x) => x.external_id === DEVICE);
  const target = d.features.find((f) => f.external_id === feature('target-temperature'));
  const ack = gladys.fake.setValue(d, target, 37);
  await settle();
  await gladys.fake.configUpdated(CONFIG);
  await settle();
  await advance(5 * SECOND);
  assert.match((await ack).error, /désactivées/);
  assert.deepEqual(spa.commands(), []);
});

test('no status after the click: decided on nothing, not sent', async (t) => {
  const { spa, command } = await setup(t, { config: HEATING });
  spa.quiet = true;
  const ack = await command('target-temperature', 37);
  assert.match(ack.error, /n'a pas envoyé son état/);
  assert.deepEqual(spa.commands(), []);
});

test('a setpoint the spa does not apply: "sent, without confirmation"', async (t) => {
  const { spa, command } = await setup(t, { config: HEATING });
  spa.ignore = true;
  const ack = await command('target-temperature', 37);
  assert.match(ack.error, /Commande envoyée, sans confirmation/);
  assert.deepEqual(spa.commands(), [[SET_TEMPERATURE, 74]]);
});

test('heat mode: "rest" always allowed (protective), "ready" behind the option', async (t) => {
  const { gladys, spa, command } = await setup(t);
  assert.equal((await command('heat-mode', 'rest')).success, true);
  assert.deepEqual(spa.commands(), [[TOGGLE, 0x51]]);
  assert.equal(last(gladys, 'heat-mode'), 'rest');
  assert.match((await command('heat-mode', 'ready')).error, /désactivées/);
  assert.match((await command('heat-mode', 'eco')).error, /Valeur inattendue/);
  assert.equal(spa.commands().length, 1);
});

test('heat mode "ready in rest" to "ready": two toggles, each after the previous one showed', async (t) => {
  const spa = fakeSpa();
  spa.heatMode = 2;
  const { command } = await setup(t, { spa, config: HEATING });
  assert.equal((await command('heat-mode', 'ready')).success, true);
  assert.deepEqual(spa.commands(), [
    [TOGGLE, 0x51],
    [TOGGLE, 0x51],
  ]);
  assert.equal(spa.heatMode, 0);
});

// --- Pumps and lights ------------------------------------------------------

test('pumps: off by default except "Off"; a two-speed pump stepped one toggle at a time', async (t) => {
  const spa = fakeSpa();
  spa.pumps[0] = 1;
  const { gladys, command } = await setup(t, { spa });
  assert.match((await command('pump-1', 'high')).error, /pompes et souffleurs sont désactivées/);
  assert.deepEqual(spa.commands(), []);
  // low -> high -> off: two toggles, the second after a status showed "high".
  assert.equal((await command('pump-1', 'off')).success, true);
  assert.deepEqual(spa.commands(), [
    [TOGGLE, 0x04],
    [TOGGLE, 0x04],
  ]);
  assert.equal(spa.pumps[0], 0);
  assert.equal(last(gladys, 'pump-1'), 'off');
  assert.equal((await command('pump-1', 'off')).success, true, 'already off');
  assert.equal(spa.commands().length, 2);
});

test('pumps allowed: values checked against the pump, pumps 7 and 8 never commanded', async (t) => {
  const { spa, command } = await setup(t, { config: JETS });
  assert.equal((await command('pump-2', 'on')).success, true);
  assert.deepEqual(spa.commands(), [[TOGGLE, 0x05]]);
  assert.match((await command('pump-2', 'high')).error, /Valeur inattendue/);
  assert.match((await command('pump-1', 1)).error, /Valeur inattendue/);
  assert.equal((await command('pump-1', 'high')).success, true);
  assert.equal(spa.pumps[0], 2);
});

test('a toggle the spa does not apply: "sent, without confirmation", then guarded', async (t) => {
  const { spa, command, advance } = await setup(t, { config: JETS });
  spa.ignore = true;
  assert.match((await command('pump-2', 'on')).error, /Commande envoyée, sans confirmation/);
  assert.equal(spa.commands().length, 1);
  // The same again while the first may still act: nothing sent, on its way.
  assert.equal((await command('pump-2', 'on')).success, true);
  // Another one: refused, never a second toggle on an unknown outcome.
  spa.ignore = false;
  spa.pumps[0] = 1;
  await advance(SECOND);
  assert.equal(spa.commands().length, 1);
  await advance(20 * SECOND);
  // The guard expired: decided again on a fresh status.
  assert.equal((await command('pump-2', 'on')).success, true);
  assert.equal(spa.commands().length, 2);
});

test('a stop cancels a pump command still running and is never refused by the option', async (t) => {
  const { gladys, spa, advance, command } = await setup(t, { config: JETS });
  spa.quiet = true;
  const d = gladys.fake.devices.find((x) => x.external_id === DEVICE);
  const pump = d.features.find((f) => f.external_id === feature('pump-1'));
  const start = gladys.fake.setValue(d, pump, 'high');
  await settle();
  await advance(300);
  await gladys.fake.configUpdated(CONFIG);
  await settle();
  const stop = gladys.fake.setValue(d, pump, 'off');
  await settle();
  spa.quiet = false;
  await advance(5 * SECOND);
  assert.match((await start).error, /Annulée par une commande d'arrêt/);
  assert.equal((await stop).success, true, 'already off');
  assert.deepEqual(spa.commands(), []);
  assert.match((await command('pump-1', 'low')).error, /désactivées/);
});

test('a second command while one runs: refused, unless it is a stop', async (t) => {
  const { gladys, spa, advance } = await setup(t, { config: JETS });
  const d = gladys.fake.devices.find((x) => x.external_id === DEVICE);
  const pump1 = d.features.find((f) => f.external_id === feature('pump-1'));
  const pump2 = d.features.find((f) => f.external_id === feature('pump-2'));
  const first = gladys.fake.setValue(d, pump1, 'low');
  await settle();
  const second = gladys.fake.setValue(d, pump2, 'on');
  await settle();
  await advance(5 * SECOND);
  assert.equal((await first).success, true);
  assert.match((await second).error, /encore en cours/);
  assert.deepEqual(spa.commands(), [[TOGGLE, 0x04]]);
});

test('lights: on and off by default, "off" only when turned off in the configuration', async (t) => {
  const { gladys, spa, command } = await setup(t);
  assert.equal((await command('light-1', 1)).success, true);
  assert.equal(last(gladys, 'light-1'), 1);
  await gladys.fake.configUpdated({ ...CONFIG, allow_lights: false });
  await settle();
  assert.equal((await command('light-1', 0)).success, true);
  assert.match((await command('light-1', 1)).error, /éclairage est désactivé/);
  assert.match((await command('light-1', 2)).error, /Valeur inattendue/);
  assert.deepEqual(spa.commands(), [
    [TOGGLE, 0x11],
    [TOGGLE, 0x11],
  ]);
});

test('read-only features refuse every command', async (t) => {
  const { command, spa } = await setup(t, { config: { ...HEATING, allow_jets: true } });
  for (const role of ['heating', 'status', 'circulation-pump', 'water-temperature']) {
    assert.match((await command(role, 1)).error, /lecture seule/);
  }
  assert.deepEqual(spa.commands(), []);
});

// --- Connection --------------------------------------------------------------

test('the connection lost: unreachable, then connected again after the backoff', async (t) => {
  const { gladys, spa, advance, app } = await setup(t);
  spa.down = true;
  for (const s of spa.sockets) s.destroy();
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /Pas de connexion au spa 192\.168\.1\.80 \(closed/);
  assert.equal(last(gladys, 'status'), 'Spa injoignable');
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.UNREACHABLE);
  await advance(10 * SECOND, SECOND);
  assert.equal(spa.connects.length, 2);
  assert.match(message(gladys).fr, /unreachable ; nouvel essai dans 30 s/);
  spa.down = false;
  await advance(32 * SECOND, SECOND);
  assert.equal(spa.connects.length, 3);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.LOCAL);
  assert.ok(app.live);
});

test('a stream that is not a spa drops the connection', async (t) => {
  const { gladys, spa, logs } = await setup(t);
  spa.inject(Buffer.alloc(5000, 0x41));
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /\(protocol;/);
  assert.ok(logs.some((l) => /protocol/.test(l)));
});

test('a quiet spa: "device present" after 15 s, the connection dropped after 45 s', async (t) => {
  const { gladys, spa, advance } = await setup(t);
  spa.quiet = true;
  spa.mute = true;
  const presents = () => spa.received.filter((f) => f.type === 0x04).length;
  const before = presents();
  await advance(21 * SECOND, SECOND);
  assert.ok(presents() > before);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  await advance(30 * SECOND, SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /silent/);
});

test('garbage between frames, split frames and bad checksums are skipped', async (t) => {
  const { gladys, spa, advance } = await setup(t);
  spa.temperature = 76;
  const good = Buffer.from([0x7e, 0x1d, 0xff, 0xaf, 0x13, ...spa.statusPayload()]);
  // A frame with a bad checksum, then garbage, then the good one in two halves.
  spa.quiet = true;
  spa.inject([0x7e, 0x05, 0x0a, 0xbf, 0x04, 0x00, 0x7e, 0x01, 0x02]);
  const { spaFrame } = await import('./helpers/fakeSpa.js');
  const frame = spaFrame(0x13, [...spa.statusPayload()], [0xff, 0xaf]);
  assert.equal(frame.subarray(0, good.length).equals(good), true);
  spa.inject(frame.subarray(0, 10));
  await settle();
  spa.inject(frame.subarray(10));
  await settle();
  await advance(16 * SECOND, SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(last(gladys, 'water-temperature'), 38);
});

test('a reconnection to Gladys republishes status, Discovery and badge, the spa connection stays', async (t) => {
  const { gladys, spa, app } = await setup(t);
  gladys.fake.discoveredDevices.length = 0;
  await app.connected(CONFIG);
  await settle();
  assert.equal(spa.connects.length, 1);
  assert.ok(discovered(gladys));
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.LOCAL);
});

test('a republished device never loses a feature', async (t) => {
  const { gladys, app } = await setup(t);
  const created = gladys.fake.devices.find((x) => x.external_id === DEVICE);
  created.features.push({
    name: 'Pompe 3',
    external_id: feature('pump-3'),
    category: 'text',
    type: 'select',
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: true,
    supported_options: [{ value: 'off', label: 'Arrêt', sort_order: 0 }],
  });
  await gladys.fake.deviceUpdated(created);
  await settle();
  await app.scan();
  assert.ok(roles(discovered(gladys)).includes('pump-3'));
});

test('the test button connects at once when the spa is not connected', async (t) => {
  const { gladys, spa } = await setup(t);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /Connecté : Balboa BP501G1/);
  spa.down = true;
  for (const s of spa.sockets) s.destroy();
  await settle();
  const again = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(again.data.message.fr, /moins de 10 s/);
});

test('the MAC address never appears in the logs', async (t) => {
  const logs = [];
  const { command } = await setup(t, { config: { ...HEATING, allow_jets: true }, logs });
  await command('pump-1', 'low');
  await command('target-temperature', 37);
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => !l.includes(MAC) && !/00:15:27/i.test(l)));
});
