// -----------------------------------------------------------------------------
// The spa -> one Gladys device and its states (pure).
//
// `ext:<selector>:balboa:<mac>`: the MAC address of the Wi-Fi module (module
// identification), 12 hex digits, the only stable key (the IP address may
// change). The feature roles (the last part of their external ids) are
// published forever: never rename them.
//
// No switch, no writable binary for the pumps, the blowers or the heating: a
// "turn everything off/on" (Google Home, Alexa, HomeKit, MCP, `switch.*`
// scenes) must never reach them. Pumps and blowers are `text/select` lists
// (off/low/high...), the heat mode a `text/select` (ready/rest), the setpoint
// `thermostat/target-temperature` (10–40 °C slider; the configured ceiling
// refuses above it). Only the lights are `light/binary`. Heating, filter
// cycles, circulation pump, auxiliaries and misters are read-only
// `unknown/binary`.
//
// A device published again never loses a feature: those of the device
// already created in Gladys are kept as they are (the core would mark it
// `structure_changed`, and "Update" would delete the missing feature and its
// history).
//
// Units are those the core lists (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on
// `temperature-sensor` and `thermostat`. Always °C: a spa set to °F is
// converted.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES as F, SETPOINT_FEATURE } from './constants.js';
import { COMMAND_PUMPS, SPEEDS, speedOf } from './balboa/protocol.js';
import { DEVICE_NAME, FEATURE_NAMES, OPTION_NAMES, STATE_TEXTS, word } from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: true,
};

/** The roles every spa has, in display order. */
export const BASE_ROLES = [
  F.WATER_TEMPERATURE,
  F.TARGET_TEMPERATURE,
  F.HEATING,
  F.HEAT_MODE,
  F.STATUS,
  F.TEMPERATURE_RANGE,
  F.FILTER_1,
  F.FILTER_2,
];

const EQUIPMENT = [F.PUMP, F.BLOWER, F.LIGHT, F.AUX, F.MISTER];

/** `{ kind, number }` of an equipment role (`pump-2` -> pump, 2), else undefined. */
export function equipmentOf(role) {
  const match = /^([a-z]+)-([1-8])$/.exec(role);
  if (!match || !EQUIPMENT.includes(match[1])) {
    return undefined;
  }
  return { kind: match[1], number: Number(match[2]) };
}

const VALID_ROLE = (role) =>
  BASE_ROLES.includes(role) || role === F.CIRCULATION_PUMP || Boolean(equipmentOf(role));

/** The roles a device configuration gives, after the base ones. */
export function rolesOf(configuration) {
  const roles = [...BASE_ROLES];
  if (!configuration) {
    return roles;
  }
  if (configuration.circulation) {
    roles.push(F.CIRCULATION_PUMP);
  }
  const add = (kind, list) => {
    for (const { index } of list) {
      roles.push(`${kind}-${index + 1}`);
    }
  };
  add(F.PUMP, configuration.pumps);
  add(F.BLOWER, configuration.blowers);
  add(F.LIGHT, configuration.lights);
  add(F.AUX, configuration.aux);
  add(F.MISTER, configuration.misters);
  return roles;
}

/** The number of states of a pump or blower (2 when the configuration is not known). */
export function statesOf(configuration, kind, number) {
  const list = kind === F.PUMP ? configuration?.pumps : configuration?.blowers;
  return list?.find((entry) => entry.index === number - 1)?.states ?? 2;
}

/** Whether a role is a command: a pump 1–6, a blower, a light, the heat mode or the setpoint. */
export function isCommand(role) {
  if (role === F.TARGET_TEMPERATURE || role === F.HEAT_MODE) {
    return true;
  }
  const equipment = equipmentOf(role);
  if (!equipment) {
    return false;
  }
  if (equipment.kind === F.PUMP) {
    return equipment.number <= COMMAND_PUMPS;
  }
  return equipment.kind === F.BLOWER || equipment.kind === F.LIGHT;
}

function speedOptions(states, language) {
  return SPEEDS[states].map((value, index) => ({
    value,
    label: word(OPTION_NAMES[value], language),
    sort_order: index,
  }));
}

/** The definition of a feature, by role. */
export function definitionOf(role, configuration, language) {
  switch (role) {
    case F.WATER_TEMPERATURE:
      return sensor({
        category: C.TEMPERATURE_SENSOR,
        type: T.TEMPERATURE_SENSOR.PROBE,
        unit: U.CELSIUS,
        min: -20,
        max: 80,
      });
    case F.TARGET_TEMPERATURE:
      return {
        category: C.THERMOSTAT,
        type: T.THERMOSTAT.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        min: SETPOINT_FEATURE.min,
        max: SETPOINT_FEATURE.max,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      };
    case F.HEAT_MODE:
      return {
        ...select,
        supported_options: ['ready', 'rest'].map((value, index) => ({
          value,
          label: word(OPTION_NAMES[value], language),
          sort_order: index,
        })),
      };
    case F.STATUS:
    case F.TEMPERATURE_RANGE:
      return text;
    default:
      break;
  }
  const equipment = equipmentOf(role);
  if (equipment?.kind === F.PUMP || equipment?.kind === F.BLOWER) {
    if (!isCommand(role)) {
      return text;
    }
    const states = statesOf(configuration, equipment.kind, equipment.number);
    return { ...select, supported_options: speedOptions(states, language) };
  }
  if (equipment?.kind === F.LIGHT) {
    return {
      category: C.LIGHT,
      type: T.LIGHT.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    };
  }
  return binary;
}

function nameOf(role, language) {
  const equipment = equipmentOf(role);
  if (equipment) {
    return word(FEATURE_NAMES[equipment.kind](equipment.number), language);
  }
  return word(FEATURE_NAMES[role], language);
}

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export const deviceIds = (gladys, mac) => gladys.externalIds('balboa', mac);

/** The MAC and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) {
    return undefined;
  }
  const match = /:balboa:([0-9a-f]{12}):([a-z0-9-]+)$/.exec(externalId);
  if (!match || !VALID_ROLE(match[2])) {
    return undefined;
  }
  return { mac: match[1], role: match[2] };
}

/** The MAC of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:balboa:([0-9a-f]{12})$/.exec(String(externalId ?? '').slice(0, 200));
  return match ? match[1] : undefined;
}

/**
 * The Gladys device of the spa. `roles`: those to show (in order);
 * `created`: the device already created in Gladys, whose features are kept
 * when the new build lacks them.
 */
export function buildDevice(gladys, mac, { roles, configuration, info, language, created }) {
  const ids = deviceIds(gladys, mac);
  const params = [];
  if (info?.version) {
    params.push({ name: 'software', value: info.version });
  }
  const built = {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    model: info?.model ? `Balboa ${info.model}` : 'Balboa',
    should_poll: false,
    features: roles.map((role) => ({
      name: nameOf(role, language),
      external_id: ids.feature(role),
      ...definitionOf(role, configuration, language),
    })),
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/** The one-line text of the spa state. */
export function statusText(status, language) {
  const spa = word(STATE_TEXTS.spa[status.state] ?? STATE_TEXTS.spa.unknown, language);
  const parts = [];
  if (status.heatMode) {
    parts.push(word(STATE_TEXTS.heatMode[status.heatMode], language));
  }
  if (status.heatState) {
    parts.push(word(STATE_TEXTS.heatState[status.heatState], language));
  }
  if (status.wifi && status.wifi !== 'ok' && STATE_TEXTS.wifi[status.wifi]) {
    parts.push(word(STATE_TEXTS.wifi[status.wifi], language));
  }
  return parts.length > 0 ? `${spa} (${parts.join(', ')})` : spa;
}

/** The current value of one role, `{ state }` or `{ text }`, else undefined. */
export function valueOf(role, status, configuration, language) {
  switch (role) {
    case F.WATER_TEMPERATURE:
      return status.temperature === undefined ? undefined : { state: status.temperature };
    case F.TARGET_TEMPERATURE:
      return status.target === undefined ? undefined : { state: status.target };
    case F.HEATING:
      return status.heatState ? { state: status.heatState === 'heating' ? 1 : 0 } : undefined;
    case F.HEAT_MODE:
      // "Ready in rest": the mode chosen is rest (it heats now, then rests again).
      return status.heatMode ? { text: status.heatMode === 'ready' ? 'ready' : 'rest' } : undefined;
    case F.STATUS:
      return { text: statusText(status, language) };
    case F.TEMPERATURE_RANGE:
      return { text: word(STATE_TEXTS.range[status.range], language) };
    case F.FILTER_1:
      return { state: status.filter1 };
    case F.FILTER_2:
      return { state: status.filter2 };
    case F.CIRCULATION_PUMP:
      return { state: status.circulation };
    default:
      break;
  }
  const equipment = equipmentOf(role);
  if (!equipment) {
    return undefined;
  }
  const i = equipment.number - 1;
  switch (equipment.kind) {
    case F.PUMP:
    case F.BLOWER: {
      const raw = equipment.kind === F.PUMP ? status.pumps[i] : status.blowers[i];
      const option = speedOf(raw, statesOf(configuration, equipment.kind, equipment.number));
      if (option === undefined) {
        return undefined;
      }
      return isCommand(role) ? { text: option } : { text: word(OPTION_NAMES[option], language) };
    }
    case F.LIGHT:
      return status.lights[i] === undefined ? undefined : { state: status.lights[i] ? 1 : 0 };
    case F.AUX:
      return status.aux[i] === undefined ? undefined : { state: status.aux[i] };
    default:
      return status.misters[i] === undefined ? undefined : { state: status.misters[i] };
  }
}

/**
 * The current values of the device, `[{ role, state | text }]`. Offline:
 * only the status text changes, Gladys keeps the last value of the others.
 */
export function deviceStates(roles, status, { configuration, language, online = true }) {
  if (!online || !status) {
    return [{ role: F.STATUS, text: word(STATE_TEXTS.offline, language) }];
  }
  const states = [];
  for (const role of roles) {
    const value = valueOf(role, status, configuration, language);
    if (value === undefined) {
      continue;
    }
    if ('state' in value && (typeof value.state !== 'number' || !Number.isFinite(value.state))) {
      continue;
    }
    states.push({ role, ...value });
  }
  return states;
}
