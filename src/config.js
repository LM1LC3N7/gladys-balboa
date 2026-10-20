// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, SPA_CAP } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  allow_heating: false,
  max_temperature: SPA_CAP.default,
  allow_jets: false,
  allow_lights: true,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of the Wi-Fi module typed by the user: an IPv4 address or a
 * host name, with an optional port (4257 by default). A pasted URL is reduced
 * to its host and port.
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '')
    .trim()
    .toLowerCase();
  text = text.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '');
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:@]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';
/** Only `false` (or the text "false") refuses: for an option on by default. */
const unlessFalse = (value) => !(value === false || value === 'false');

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,4}(\.\d{1,3})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The setpoint ceiling: half degrees within SPA_CAP, else the default
 * (38 °C). Never above 40 °C, whatever was typed; rounded down.
 */
export function capOf(value) {
  const number = numberOf(value);
  if (number === undefined) {
    return SPA_CAP.default;
  }
  return Math.min(SPA_CAP.max, Math.max(SPA_CAP.min, Math.floor(number * 2) / 2));
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = String(c.address ?? '').trim();
  const address = parseAddress(typed);
  return {
    address,
    /** What was typed, when it is not a valid address (shown in the status). */
    invalid: typed !== '' && !address ? typed.slice(0, 100) : undefined,
    allowHeating: strictTrue(c.allow_heating),
    cap: capOf(c.max_temperature),
    allowJets: strictTrue(c.allow_jets),
    allowLights: unlessFalse(c.allow_lights),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
