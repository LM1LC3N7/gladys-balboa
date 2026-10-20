// -----------------------------------------------------------------------------
// The integration: the Wi-Fi module typed in the configuration (its IP
// address), one TCP connection kept open (the spa streams its status), the
// Gladys device of the spa and its states, the transport badge, the "Test the
// connection" button, and the commands. index.js only wires the SDK handlers.
//
// The commands follow the rules learnt on the previous modules:
//   - the heating (setpoint, "ready" heat mode) and the pumps/blowers are
//     refused unless their option allows them (both off by default); the
//     setpoint is never above the configured ceiling (38 °C by default) nor
//     40 °C; "Off" for a pump or a blower, "Rest" for the heat mode and
//     "off" for a light are never refused by an option (protective), and
//     cancel a command still running that is not one;
//   - decided on a status received AFTER the click, never on the one kept in
//     memory, and refused when the value they need is missing;
//   - the options (and the ceiling) are checked on arrival and again right
//     before every frame leaves (`beforeSend`);
//   - every frame leaves within 3.5 s of the click or is not sent; the
//     effect is awaited in the statuses until 4.3 s, then the answer is
//     "sent, without confirmation" (the protocol has no acknowledgement);
//   - most settings are toggles: one toggle at a time, the next one only
//     after a status showed the previous one; a guard after every toggle
//     until a status shows the expected state (never lifted on an unknown
//     state), never retried;
//   - the ack never waits for a publication to Gladys;
//   - one command at a time.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig, numberOf } from './config.js';
import { FEATURES as F, SETPOINT_FEATURE, SPA_CAP, TIMINGS } from './constants.js';
import {
  buildDevice,
  deviceIds,
  deviceStates,
  equipmentOf,
  isCommand,
  parseDeviceId,
  parseFeatureId,
  rolesOf,
  statesOf,
} from './devices.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { BalboaConnection, BalboaError, ERROR_KINDS, errorReason } from './balboa/client.js';
import {
  DEFAULT_RANGES,
  MESSAGE,
  REQUESTS,
  SPEEDS,
  TOGGLE,
  parseDeviceConfiguration,
  parseModuleIdentification,
  parseSetupParameters,
  parseStatus,
  parseSystemInformation,
  speedOf,
  toCelsius,
} from './balboa/protocol.js';
import { StatePublisher } from './publisher.js';

/** A wait that ended without its status. */
class WaitError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

export class BalboaApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'balboa' }),
    connect,
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    /** The socket factory (tests); node:net otherwise. */
    this.connect = connect;
    this.now = now;
    this.timers = timers;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.spa = undefined;
    /** mac -> the roles seen while the integration runs (a feature never disappears). */
    this.seen = new Map();
    this.generation = 0;
    this.started = false;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    this.watchdog = undefined;
    /** The command running: `{ run, promise }`. */
    this.inFlight = undefined;
    /** `${mac}:${role}` -> { from, expected, moved, until }: a toggle sent, not seen yet. */
    this.guards = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  freshSpa(address) {
    return {
      address,
      conn: undefined,
      /** The TCP connection is open. */
      linked: false,
      /** false after a failure; true once linked. */
      online: undefined,
      failures: 0,
      wait: undefined,
      error: undefined,
      timer: undefined,
      mac: undefined,
      info: undefined,
      setup: undefined,
      configuration: undefined,
      status: undefined,
      statusKey: undefined,
      statusSeq: 0,
      lastFrameAt: 0,
      tempQueuedAt: -Infinity,
      configTries: 0,
      configAt: -Infinity,
      waiters: new Set(),
    };
  }

  async start(raw = {}) {
    this.stop();
    this.config = normalizeConfig(raw);
    this.spa = this.config.address ? this.freshSpa(this.config.address) : undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.spa) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    const generation = this.generation;
    this.watchdog = this.timers.setInterval(() => {
      if (generation === this.generation) {
        this.check();
      }
    }, TIMINGS.watchdog);
    await this.updateStatus();
    await this.dial(this.spa);
  }

  stop() {
    this.generation += 1;
    if (this.watchdog) {
      this.timers.clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    const spa = this.spa;
    if (spa) {
      if (spa.timer) {
        this.timers.clearTimeout(spa.timer);
        spa.timer = undefined;
      }
      spa.conn?.close();
      this.endWaiters(spa, 'closed');
    }
    this.publisher.stop();
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge) and the last states. The connection to the spa stays.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishAll();
  }

  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalid !== this.config.invalid
    );
  }

  /** A new address restarts; the options, the ceiling and the language apply at once. */
  async configUpdated(raw = {}) {
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    if (
      this.config.allowHeating !== previous.allowHeating ||
      this.config.allowJets !== previous.allowJets ||
      this.config.allowLights !== previous.allowLights ||
      this.config.cap !== previous.cap
    ) {
      this.logger.info(
        `Balboa options: heating ${this.config.allowHeating ? 'allowed' : 'disabled'} (ceiling ${this.config.cap} °C), pumps ${this.config.allowJets ? 'allowed' : 'disabled'}, lights ${this.config.allowLights ? 'allowed' : 'disabled'}`,
      );
    }
    if (this.config.language !== previous.language) {
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- The connection ----------------------------------------------------------

  async dial(spa) {
    const generation = this.generation;
    if (spa.timer) {
      this.timers.clearTimeout(spa.timer);
      spa.timer = undefined;
    }
    const conn = new BalboaConnection({
      host: spa.address.host,
      port: spa.address.port,
      timers: this.timers,
      now: this.now,
      ...(this.connect ? { connect: this.connect } : {}),
      onFrame: (frame) => {
        if (generation === this.generation && spa.conn === conn) {
          this.onFrame(spa, frame);
        }
      },
      onClose: (err) => {
        if (generation === this.generation && spa.conn === conn) {
          this.onClosed(spa, err);
        }
      },
    });
    spa.conn = conn;
    try {
      await conn.open();
    } catch (err) {
      if (generation === this.generation && spa.conn === conn) {
        await this.failed(spa, err);
      }
      return;
    }
    if (generation !== this.generation || spa.conn !== conn) {
      conn.close();
      return;
    }
    spa.linked = true;
    spa.online = true;
    spa.error = undefined;
    spa.wait = undefined;
    spa.lastFrameAt = this.now();
    spa.configTries = 0;
    spa.configAt = -Infinity;
    // A new connection: what the spa says about itself is asked again.
    spa.status = undefined;
    spa.statusKey = undefined;
    this.requestConfiguration(spa, true);
    this.logger.info(`Balboa: connected to ${addressKey(spa.address)}`);
    await this.publishAll();
  }

  onClosed(spa, err) {
    spa.linked = false;
    this.endWaiters(spa, 'closed');
    this.failed(spa, err).catch(() => {});
  }

  async failed(spa, err) {
    const reason = errorReason(err);
    const wait = TIMINGS.backoff[Math.min(spa.failures, TIMINGS.backoff.length - 1)];
    spa.failures += 1;
    spa.online = false;
    spa.linked = false;
    spa.error = reason;
    spa.wait = wait;
    const generation = this.generation;
    if (spa.timer) {
      this.timers.clearTimeout(spa.timer);
    }
    spa.timer = this.timers.setTimeout(() => {
      spa.timer = undefined;
      if (generation === this.generation && this.spa === spa) {
        this.dial(spa).catch(() => this.logger.error('Balboa connection failed'));
      }
    }, wait);
    this.logger.warn(
      `Balboa ${addressKey(spa.address)}: ${reason}; next try in ${Math.round(wait / 1000)} s`,
    );
    await this.publishAll();
  }

  /** Every few seconds: keep-alive, silence, configuration still missing, water temperature. */
  check() {
    const spa = this.spa;
    if (!spa?.linked || !spa.conn?.isOpen) {
      return;
    }
    const now = this.now();
    const silent = now - spa.lastFrameAt;
    if (silent > TIMINGS.silence) {
      this.logger.warn('Balboa: the spa stopped talking, connecting again');
      spa.conn.drop(new BalboaError(ERROR_KINDS.SILENT, { sent: true }));
      return;
    }
    if (silent > TIMINGS.keepAlive && now - (spa.conn.lastSentAt ?? 0) > TIMINGS.keepAlive) {
      this.sendQuietly(spa, MESSAGE.DEVICE_PRESENT);
    }
    this.requestConfiguration(spa);
    if (spa.status && now - spa.tempQueuedAt >= TIMINGS.statesEvery) {
      this.queueStates({ temperature: true });
      this.flush().catch(() => {});
    }
  }

  sendQuietly(spa, type, payload) {
    try {
      spa.conn.send(type, payload);
    } catch {
      // Not connected: the watchdog or the reconnection tells.
    }
  }

  /** What is still unknown of the spa, asked again (a few times per connection). */
  requestConfiguration(spa, force = false) {
    const missing = !spa.mac || !spa.info || !spa.setup || !spa.configuration;
    if (!missing) {
      return;
    }
    const now = this.now();
    if (
      !force &&
      (now - spa.configAt < TIMINGS.configRetry || spa.configTries >= TIMINGS.configRetries)
    ) {
      return;
    }
    spa.configTries += 1;
    spa.configAt = now;
    if (!spa.mac) {
      // "Device present": the module answers with its identification.
      this.sendQuietly(spa, MESSAGE.DEVICE_PRESENT);
    }
    if (!spa.info) {
      this.sendQuietly(spa, MESSAGE.REQUEST, REQUESTS.systemInformation);
    }
    if (!spa.setup) {
      this.sendQuietly(spa, MESSAGE.REQUEST, REQUESTS.setupParameters);
    }
    if (!spa.configuration) {
      this.sendQuietly(spa, MESSAGE.REQUEST, REQUESTS.deviceConfiguration);
    }
  }

  // --- What the spa says ---------------------------------------------------------

  onFrame(spa, { type, payload }) {
    spa.lastFrameAt = this.now();
    spa.failures = 0;
    switch (type) {
      case MESSAGE.STATUS_UPDATE:
        this.onStatus(spa, payload);
        return;
      case MESSAGE.MODULE_IDENTIFICATION: {
        const id = parseModuleIdentification(payload);
        if (!id) {
          return;
        }
        if (spa.mac && spa.mac !== id.mac) {
          // Another module answers at this address: what was learnt goes.
          this.logger.warn('Balboa: another spa answers at this address');
          spa.info = undefined;
          spa.setup = undefined;
          spa.configuration = undefined;
          spa.configTries = 0;
        }
        if (spa.mac !== id.mac) {
          spa.mac = id.mac;
          this.changed();
        }
        return;
      }
      case MESSAGE.SYSTEM_INFORMATION: {
        const info = parseSystemInformation(payload);
        if (info && JSON.stringify(info) !== JSON.stringify(spa.info)) {
          spa.info = info;
          this.changed();
        }
        return;
      }
      case MESSAGE.SETUP_PARAMETERS: {
        const setup = parseSetupParameters(payload);
        if (setup) {
          spa.setup = setup;
        }
        return;
      }
      case MESSAGE.DEVICE_CONFIGURATION: {
        const configuration = parseDeviceConfiguration(payload);
        if (configuration && JSON.stringify(configuration) !== JSON.stringify(spa.configuration)) {
          spa.configuration = configuration;
          this.changed();
        }
        return;
      }
      default:
        // Other messages (filter cycles, fault log, panel chatter): not used.
        return;
    }
  }

  /** Something the device depends on changed: published in the background. */
  changed() {
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
  }

  onStatus(spa, payload) {
    const status = parseStatus(payload);
    if (!status) {
      return;
    }
    const first = spa.status === undefined;
    const key = payload.toString('hex');
    const same = key === spa.statusKey;
    spa.status = status;
    spa.statusKey = key;
    spa.statusSeq += 1;
    if (spa.mac) {
      this.observe(spa.mac, status);
    }
    for (const waiter of [...spa.waiters]) {
      waiter.check();
    }
    if (first) {
      this.changed();
      return;
    }
    if (!same) {
      this.queueStates({ temperature: false });
      this.flush().catch(() => {});
    }
  }

  /** Whether the spa of a created device is connected and talking. */
  get live() {
    const spa = this.spa;
    return Boolean(spa?.linked && spa.mac && spa.status);
  }

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  /** Our created devices: [{ device, mac }]. */
  ourDevices() {
    const list = [];
    for (const device of this.gladys.devices ?? []) {
      const mac = parseDeviceId(device?.external_id);
      if (mac && deviceIds(this.gladys, mac).device === device.external_id) {
        list.push({ device, mac });
      }
    }
    return list;
  }

  /** The roles of a spa: those of its configuration, then any other seen during this run. */
  rolesFor(mac) {
    const seen = this.seen.get(mac) ?? new Set();
    const roles = mac === this.spa?.mac ? rolesOf(this.spa.configuration) : rolesOf(undefined);
    for (const role of roles) {
      seen.add(role);
    }
    this.seen.set(mac, seen);
    return [...roles, ...[...seen].filter((role) => !roles.includes(role))];
  }

  // --- Gladys ----------------------------------------------------------------

  async publishAll() {
    await this.publishDevices();
    this.queueStates({ temperature: true });
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The Discovery list: the spa connected (once identified and talking). */
  async publishDevices() {
    const spa = this.spa;
    if (!spa?.mac || !spa.status) {
      return;
    }
    const device = buildDevice(this.gladys, spa.mac, {
      roles: this.rolesFor(spa.mac),
      configuration: spa.configuration,
      info: spa.info,
      language: this.config.language,
      created: this.createdDevice(deviceIds(this.gladys, spa.mac).device),
    });
    const json = JSON.stringify([device]);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices([device]);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** Queues the states of the created devices; the water temperature at most every 10 s. */
  queueStates({ temperature }, created = this.createdFeatures()) {
    const spa = this.spa;
    for (const { mac } of this.ourDevices()) {
      const ids = deviceIds(this.gladys, mac);
      const online = this.live && mac === spa.mac;
      const states = deviceStates(this.rolesFor(mac), online ? spa.status : undefined, {
        configuration: online ? spa.configuration : undefined,
        language: this.config.language,
        online,
      });
      for (const { role, ...value } of states) {
        if (role === F.WATER_TEMPERATURE && !temperature) {
          continue;
        }
        const id = ids.feature(role);
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    }
    if (temperature && spa) {
      spa.tempQueuedAt = this.now();
    }
  }

  async publishBadge() {
    const entries = this.ourDevices().map(({ device, mac }) => ({
      external_id: device.external_id,
      transport:
        this.live && mac === this.spa.mac ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
    }));
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  withInvalid(message) {
    return this.config.invalid ? join([message, T.invalid(this.config.invalid)]) : message;
  }

  status() {
    const spa = this.spa;
    if (!spa) {
      return [false, this.withInvalid(T.noAddress)];
    }
    if (spa.online === false) {
      return [false, T.unreachable(addressKey(spa.address), spa.error, age(spa.wait))];
    }
    if (spa.online === undefined) {
      return [false, T.connecting];
    }
    if (!this.live) {
      return [false, T.waiting];
    }
    return [true, T.connected(spa.info?.model)];
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates({ temperature: true }, created);
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the spa connected, sent again. */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  async testConnection() {
    const spa = this.spa;
    if (!spa) {
      return this.withInvalid(T.noAddress);
    }
    const current = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      return join([T.test.cooldown, current()]);
    }
    this.lastTestAt = this.now();
    if (!spa.linked) {
      // A connection now, rather than at the end of the backoff.
      spa.failures = 0;
      await this.dial(spa);
    }
    if (spa.linked && !this.live) {
      await this.waitStatus(spa, () => this.live, this.now() + TIMINGS.testWait).catch(() => {});
      await this.publishAll();
    }
    return current();
  }

  // --- Waiting for the spa ---------------------------------------------------------

  /**
   * Resolves with the status for which `test(status, seq)` is true (checked
   * now and on every status), or rejects at `by`, when the connection closes,
   * or when `run` is cancelled.
   */
  waitStatus(spa, test, by, run) {
    return new Promise((resolve, reject) => {
      const waiter = {
        check: () => {
          let ok;
          try {
            ok = spa.status !== undefined && test(spa.status, spa.statusSeq);
          } catch {
            ok = false;
          }
          if (ok) {
            finish();
            resolve(spa.status);
          }
        },
        end: (kind) => {
          finish();
          reject(new WaitError(kind));
        },
      };
      const timer = this.timers.setTimeout(() => waiter.end('late'), Math.max(0, by - this.now()));
      const finish = () => {
        this.timers.clearTimeout(timer);
        spa.waiters.delete(waiter);
        if (run?.waiter === waiter) {
          run.waiter = undefined;
        }
      };
      spa.waiters.add(waiter);
      if (run) {
        if (run.cancelled) {
          waiter.end('cancelled');
          return;
        }
        run.waiter = waiter;
      }
      waiter.check();
    });
  }

  endWaiters(spa, kind) {
    for (const waiter of [...spa.waiters]) {
      waiter.end(kind);
    }
  }

  // --- The commands --------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * The value of a command, checked strictly: a setpoint is a finite number
   * or a plain decimal text ('' and null are not 0), a multiple of 0.5 °C,
   * between 10 °C and the ceiling; an option is one exact value of the list;
   * a light 0 or 1.
   */
  parseCommand(role, value) {
    if (role === F.TARGET_TEMPERATURE) {
      const number = numberOf(value);
      if (number === undefined) {
        throw this.refusal(ERRORS.badNumber);
      }
      if (!Number.isInteger(number * 2)) {
        throw this.refusal(ERRORS.badStep);
      }
      if (number > this.config.cap || number > SPA_CAP.max) {
        throw this.refusal(ERRORS.cap(this.config.cap));
      }
      if (number < SETPOINT_FEATURE.min) {
        throw this.refusal(ERRORS.outOfRange(SETPOINT_FEATURE.min, this.config.cap));
      }
      return { kind: 'setpoint', value: number, protective: false };
    }
    if (role === F.HEAT_MODE) {
      if (value !== 'ready' && value !== 'rest') {
        throw this.refusal(ERRORS.badValue);
      }
      return { kind: 'toggle', target: value, protective: value === 'rest' };
    }
    const equipment = equipmentOf(role);
    if (equipment.kind === F.LIGHT) {
      const on = value === 1 || value === '1' ? 1 : value === 0 || value === '0' ? 0 : undefined;
      if (on === undefined) {
        throw this.refusal(ERRORS.badValue);
      }
      return { kind: 'toggle', target: on, protective: on === 0, equipment };
    }
    if (typeof value !== 'string' || !SPEEDS[4].concat('on').includes(value)) {
      throw this.refusal(ERRORS.badValue);
    }
    return { kind: 'toggle', target: value, protective: value === 'off', equipment };
  }

  /** The options and the ceiling, on the latest configuration. */
  checkAllowed(role, wanted) {
    if (wanted.protective) {
      return;
    }
    if (role === F.TARGET_TEMPERATURE || role === F.HEAT_MODE) {
      if (!this.config.allowHeating) {
        throw this.refusal(ERRORS.heatingDisabled);
      }
      if (
        wanted.kind === 'setpoint' &&
        (wanted.value > this.config.cap || wanted.value > SPA_CAP.max)
      ) {
        throw this.refusal(ERRORS.cap(this.config.cap));
      }
      return;
    }
    if (wanted.equipment.kind === F.LIGHT) {
      if (!this.config.allowLights) {
        throw this.refusal(ERRORS.lightsDisabled);
      }
      return;
    }
    if (!this.config.allowJets) {
      throw this.refusal(ERRORS.jetsDisabled);
    }
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !isCommand(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.parseCommand(target.role, value);
    this.checkAllowed(target.role, wanted);
    const after = this.spa?.statusSeq ?? 0;
    const run = { protective: wanted.protective, cancelled: false, waiter: undefined };
    const previous = this.inFlight;
    if (previous) {
      if (!run.protective) {
        throw this.refusal(ERRORS.stillRunning);
      }
      if (!previous.run.protective) {
        // A stop never waits behind the command it stops.
        previous.run.cancelled = true;
        previous.run.waiter?.end('cancelled');
      }
    }
    const promise = (async () => {
      if (previous) {
        await previous.promise.catch(() => {});
      }
      return this.command(target, wanted, { received, after, run });
    })();
    const entry = { run, promise };
    this.inFlight = entry;
    try {
      return await promise;
    } finally {
      if (this.inFlight === entry) {
        this.inFlight = undefined;
      }
    }
  }

  /** The checks before every frame, on the latest configuration. */
  checkBeforeSend(context, target, wanted) {
    if (context.run.cancelled) {
      throw this.refusal(ERRORS.cancelled);
    }
    this.checkAllowed(target.role, wanted);
    if (
      context.generation !== this.generation ||
      this.spa !== context.spa ||
      !this.live ||
      this.spa.mac !== target.mac
    ) {
      throw this.refusal(ERRORS.unknownDevice);
    }
  }

  async command(target, wanted, { received, after, run }) {
    const spa = this.spa;
    const context = {
      generation: this.generation,
      spa,
      run,
      sendBy: received + TIMINGS.commandSendBy,
      answerBy: received + TIMINGS.commandAnswerBy,
    };
    if (!spa?.linked) {
      throw this.refusal(ERRORS.notConnected);
    }
    this.checkBeforeSend(context, target, wanted);
    // A status received after the click: never the one kept in memory.
    let status;
    try {
      status = await this.waitStatus(
        spa,
        (_s, seq) => seq > after,
        Math.min(received + TIMINGS.commandFreshBy, context.sendBy),
        run,
      );
    } catch (err) {
      throw this.refusal(err.kind === 'cancelled' ? ERRORS.cancelled : ERRORS.noFreshState);
    }
    this.checkBeforeSend(context, target, wanted);
    if (wanted.kind === 'setpoint') {
      return this.setpoint(context, target, wanted, status);
    }
    return this.toggle(context, target, wanted, status);
  }

  /** The raw byte of a setpoint in the unit and range the spa uses now. */
  setpointByte(status, value) {
    const which = status.raw.range ? 'high' : 'low';
    // The ranges the spa gave (setup parameters), else pybalboa's defaults.
    const range = this.spa.setup?.[which] ?? DEFAULT_RANGES[which];
    if (status.celsius) {
      const min = toCelsius(range.min);
      const max = Math.min(toCelsius(range.max), SPA_CAP.max);
      if (value < min || value > max) {
        throw this.refusal(ERRORS.outOfRange(min, max));
      }
      return value * 2;
    }
    const fahrenheit = Math.round(value * 1.8 + 32);
    if ((fahrenheit - 32) / 1.8 > Math.min(this.config.cap, SPA_CAP.max) + 1e-9) {
      throw this.refusal(ERRORS.cap(this.config.cap));
    }
    if (fahrenheit < range.min || fahrenheit > range.max) {
      throw this.refusal(ERRORS.outOfRange(toCelsius(range.min), toCelsius(range.max)));
    }
    return fahrenheit;
  }

  async setpoint(context, target, wanted, status) {
    const byte = this.setpointByte(status, wanted.value);
    const key = `${target.mac}:${target.role}`;
    if (status.raw.target === byte && !this.guardActive(key)) {
      // Already so: nothing sent.
      return;
    }
    this.send(context, target, wanted, MESSAGE.SET_TEMPERATURE, [byte], () => {
      // The ceiling may have been lowered meanwhile: the byte is checked again.
      if (
        status.celsius ? byte / 2 > this.config.cap : (byte - 32) / 1.8 > this.config.cap + 1e-9
      ) {
        throw this.refusal(ERRORS.cap(this.config.cap));
      }
    });
    this.logger.info(`Balboa setpoint: ${wanted.value} °C`);
    this.guard(key, { from: status.raw.target, expected: byte, read: (s) => s.raw.target });
    await this.confirm(context, (s) => s.raw.target === byte);
  }

  /** Sends one frame now, or refuses unsent (late, not allowed, not connected). */
  send(context, target, wanted, type, payload, extraCheck) {
    if (this.now() > context.sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    try {
      context.spa.conn.send(type, payload, {
        // The very last check, right before the bytes leave.
        beforeSend: () => {
          this.checkBeforeSend(context, target, wanted);
          extraCheck?.();
        },
      });
    } catch (err) {
      if (err.beforeSend) {
        throw err;
      }
      throw this.refusal(ERRORS.notSent(errorReason(err)));
    }
  }

  /** The effect of a frame sent, awaited in the statuses until 4.3 s after the click. */
  async confirm(context, test) {
    try {
      await this.waitStatus(context.spa, test, context.answerBy, context.run);
    } catch {
      throw this.refusal(ERRORS.sentUnconfirmed);
    }
  }

  /** How a toggled setting reads in a status: its option, 0/1, or undefined. */
  readToggle(target, status) {
    if (target.role === F.HEAT_MODE) {
      return status.heatMode;
    }
    const { kind, number } = equipmentOf(target.role);
    if (kind === F.LIGHT) {
      const value = status.lights[number - 1];
      return value === undefined ? undefined : value ? 1 : 0;
    }
    const raw = kind === F.PUMP ? status.pumps[number - 1] : status.blowers[number - 1];
    return speedOf(raw, statesOf(this.spa.configuration, kind, number));
  }

  /** The toggle code and the most toggles a command may send. */
  toggleOf(target) {
    if (target.role === F.HEAT_MODE) {
      return { code: TOGGLE.HEAT_MODE, steps: 2 };
    }
    const { kind, number } = equipmentOf(target.role);
    const configuration = this.spa.configuration;
    const list =
      kind === F.PUMP
        ? configuration?.pumps
        : kind === F.BLOWER
          ? configuration?.blowers
          : configuration?.lights;
    const entry = list?.find((e) => e.index === number - 1);
    if (!entry) {
      throw this.refusal(configuration ? ERRORS.notThere : ERRORS.missingValue);
    }
    if (kind === F.LIGHT) {
      return { code: TOGGLE.LIGHT_1 + number - 1, steps: 1 };
    }
    const base = kind === F.PUMP ? TOGGLE.PUMP_1 : TOGGLE.BLOWER;
    return { code: base + number - 1, steps: entry.states - 1, options: SPEEDS[entry.states] };
  }

  async toggle(context, target, wanted, status) {
    const { code, steps, options } = this.toggleOf(target);
    if (options && !options.includes(wanted.target)) {
      throw this.refusal(ERRORS.badValue);
    }
    const key = `${target.mac}:${target.role}`;
    let current = this.readToggle(target, status);
    if (this.guardActive(key)) {
      const guard = this.guards.get(key);
      if (guard.expected === wanted.target) {
        // The previous command asked the same: it is on its way.
        return;
      }
      if (!wanted.protective) {
        throw this.refusal(ERRORS.moving);
      }
      // A stop waits for the previous toggle to show (never a toggle on a
      // state that may be about to change), within the time to send.
      try {
        status = await this.waitStatus(
          context.spa,
          () => !this.guardActive(key),
          context.sendBy,
          context.run,
        );
      } catch {
        throw this.refusal(ERRORS.moving);
      }
      current = this.readToggle(target, status);
    }
    if (current === undefined) {
      throw this.refusal(ERRORS.missingValue);
    }
    if (current === wanted.target) {
      return;
    }
    const read = (s) => this.readToggle(target, s);
    for (let step = 0; step < steps; step += 1) {
      if (step > 0 && this.now() > context.sendBy) {
        // A toggle already left and its effect was seen, but not the end.
        throw this.refusal(ERRORS.sentUnconfirmed);
      }
      const before = current;
      try {
        this.send(context, target, wanted, MESSAGE.TOGGLE_STATE, [code]);
      } catch (err) {
        // After a first toggle, whatever stops the next one: a frame did leave.
        throw step > 0 ? this.refusal(ERRORS.sentUnconfirmed) : err;
      }
      this.logger.info(`Balboa ${target.role}: toggle towards ${wanted.target}`);
      this.guard(key, { from: before, expected: wanted.target, read });
      let seen;
      try {
        seen = await this.waitStatus(
          context.spa,
          (s) => {
            const value = read(s);
            return value !== undefined && value !== before;
          },
          context.answerBy,
          context.run,
        );
      } catch {
        throw this.refusal(ERRORS.sentUnconfirmed);
      }
      current = read(seen);
      if (current === wanted.target) {
        return;
      }
    }
    // Every toggle allowed was sent and none gave the state asked.
    throw this.refusal(ERRORS.sentUnconfirmed);
  }

  // --- Guards ----------------------------------------------------------------------

  /**
   * After a frame that changes a setting, until a status shows its effect:
   * nothing is decided on a state that may not show it yet (a toggle sent
   * twice would undo itself). The guard keeps the value from before the
   * frame: only a status with another value lifts it (the frame acted);
   * a status equal to it, or unknown, lifts nothing. 20 s at most.
   */
  guard(key, { from, expected, read }) {
    this.guards.set(key, { from, expected, read, until: this.now() + TIMINGS.guard });
  }

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A status, through the guards of its spa. */
  observe(mac, status) {
    for (const [key, guard] of [...this.guards]) {
      if (!key.startsWith(`${mac}:`) || !this.guardActive(key)) {
        continue;
      }
      let value;
      try {
        value = guard.read(status);
      } catch {
        value = undefined;
      }
      if (value !== undefined && value !== guard.from) {
        this.guards.delete(key);
      }
    }
  }
}
