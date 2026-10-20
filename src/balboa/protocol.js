// -----------------------------------------------------------------------------
// The messages of the Balboa local protocol (ported from pybalboa 1.1.4:
// `enums.py`, `client.py`, `control.py`). Pure functions: bytes in, plain
// objects out. A payload shorter than its known layout is ignored (undefined),
// never read past its end.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

export const MESSAGE = {
  DEVICE_PRESENT: 0x04,
  TOGGLE_STATE: 0x11,
  STATUS_UPDATE: 0x13,
  SET_TEMPERATURE: 0x20,
  REQUEST: 0x22,
  FILTER_CYCLE: 0x23,
  SYSTEM_INFORMATION: 0x24,
  SETUP_PARAMETERS: 0x25,
  FAULT_LOG: 0x28,
  DEVICE_CONFIGURATION: 0x2e,
  MODULE_IDENTIFICATION: 0x94,
};

/** What a REQUEST asks (its three payload bytes, pybalboa `request_*`). */
export const REQUESTS = {
  systemInformation: [0x02, 0x00, 0x00],
  setupParameters: [0x04, 0x00, 0x00],
  deviceConfiguration: [0x00, 0x00, 0x01],
};

/** Toggle item codes (pybalboa ToggleItemCode); an index is added for pumps, blowers, lights. */
export const TOGGLE = {
  PUMP_1: 0x04,
  BLOWER: 0x0c,
  LIGHT_1: 0x11,
  HEAT_MODE: 0x51,
};

/** Pumps 1 to 6 have a toggle code (0x04 to 0x09): 7 and 8 are read only. */
export const COMMAND_PUMPS = 6;

export const SPA_STATES = {
  0x00: 'running',
  0x01: 'initializing',
  0x05: 'hold',
  0x14: 'ab-temps',
  0x17: 'test',
};

export const HEAT_MODES = ['ready', 'rest', 'ready-in-rest'];
export const HEAT_STATES = ['off', 'heating', 'waiting'];
export const WIFI_STATES = ['ok', 'spa-not-communicating', 'startup', 'prime', 'hold', 'panel'];

/** The option names of a pump or blower, by its number of states (pybalboa STATE_OPTIONS_MAP). */
export const SPEEDS = {
  2: ['off', 'on'],
  3: ['off', 'low', 'high'],
  4: ['off', 'low', 'medium', 'high'],
};

/** pybalboa `byte_parser`: `count` fields of `bits` bits from bit `offset`. */
export function fields(value, { offset = 0, count = 8, bits = 1 } = {}) {
  const mask = (1 << bits) - 1;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push((value >> (i * bits + offset)) & mask);
  }
  return out;
}

/** pybalboa `to_celsius`: °F to °C, to the half degree. */
export const toCelsius = (fahrenheit) => 0.5 * Math.round((fahrenheit - 32) / 1.8 / 0.5);

/** A temperature byte of the spa in °C (one decimal), or undefined. */
export function celsiusOf(raw, celsius) {
  if (!Number.isInteger(raw) || raw === 0xff) {
    return undefined;
  }
  const value = celsius ? raw / 2 : Math.round(((raw - 32) / 1.8) * 10) / 10;
  return value >= -20 && value <= 80 ? value : undefined;
}

/**
 * Status update (24 bytes, pybalboa `_parse_status_update`). Temperatures in
 * °C (one decimal); `raw` keeps the bytes a command needs.
 */
export function parseStatus(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 24) {
    return undefined;
  }
  const d = payload;
  const celsius = (d[9] & 0x01) !== 0;
  const pumps = [...fields(d[11], { count: 4, bits: 2 }), ...fields(d[12], { count: 4, bits: 2 })];
  return {
    state: Object.hasOwn(SPA_STATES, d[0]) ? SPA_STATES[d[0]] : 'unknown',
    celsius,
    temperature: celsiusOf(d[2], celsius),
    target: celsiusOf(d[20], celsius),
    heatMode: HEAT_MODES[d[5] & 0x03],
    filter1: (d[9] & 0x04) !== 0 ? 1 : 0,
    filter2: (d[9] & 0x08) !== 0 ? 1 : 0,
    range: (d[10] >> 2) & 0x01 ? 'high' : 'low',
    heatState: HEAT_STATES[(d[10] >> 4) & 0x03],
    pumps,
    circulation: (d[13] & 0x03) >> 1,
    blowers: fields(d[13], { offset: 1, count: 2, bits: 2 }),
    lights: fields(d[14], { count: 4, bits: 2 }).map((v) => v >> 1),
    misters: fields(d[15], { count: 3 }),
    aux: fields(d[15], { offset: 3, count: 4 }),
    wifi: WIFI_STATES[(d[22] & 0xf0) >> 4],
    raw: { target: d[20], range: (d[10] >> 2) & 0x01, heatMode: d[5] & 0x03 },
  };
}

/** Module identification (25 bytes): the MAC address of the Wi-Fi module, as 12 hex digits. */
export function parseModuleIdentification(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 25) {
    return undefined;
  }
  return { mac: payload.subarray(3, 9).toString('hex') };
}

/** System information (21 bytes): model and software version. */
export function parseSystemInformation(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 21) {
    return undefined;
  }
  const model = [...payload.subarray(4, 4 + LIMITS.modelLength)]
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ''))
    .join('')
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .trim();
  return {
    model: model || undefined,
    version: `M${payload[0]}_${payload[1]} V${payload[2]}.${payload[3]}`,
  };
}

/** Setup parameters (9 bytes): the low and high ranges of the setpoint, in °F. */
export function parseSetupParameters(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 9) {
    return undefined;
  }
  const range = (min, max) => (min > 0 && max >= min && max <= 120 ? { min, max } : undefined);
  return {
    low: range(payload[2], payload[3]),
    high: range(payload[4], payload[5]),
  };
}

/** pybalboa defaults, when the setup parameters did not come (°F). */
export const DEFAULT_RANGES = { low: { min: 50, max: 99 }, high: { min: 80, max: 104 } };

/**
 * Device configuration (6 bytes): which pumps, lights, blowers, misters and
 * auxiliaries exist, with their number of states (pybalboa
 * `_parse_device_configuration`). Indexes start at 0.
 */
export function parseDeviceConfiguration(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 6) {
    return undefined;
  }
  const d = payload;
  const present = (values) =>
    values.flatMap((v, index) => (v > 0 ? [{ index, states: Math.min(4, v + 1) }] : []));
  return {
    pumps: present([
      ...fields(d[0], { count: 4, bits: 2 }),
      d[1] & 0x03,
      (d[1] >> 6) & 0x03,
      (d[1] >> 4) & 0x03,
      (d[1] >> 2) & 0x03,
    ]),
    lights: present(fields(d[2], { count: 4, bits: 2 })),
    circulation: d[3] >> 7 === 1,
    blowers: present(fields(d[3], { count: 2, bits: 2 })),
    aux: present(fields(d[4], { count: 4 })),
    misters: present(fields(d[4], { offset: 4, count: 3 })),
  };
}

/**
 * The option of a pump or blower for a status value (pybalboa
 * `SpaControl.update`: a pump value beyond its states is its last option).
 */
export function speedOf(value, states) {
  const options = SPEEDS[states];
  if (!options || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return options[Math.min(value, options.length - 1)];
}
