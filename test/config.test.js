import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capOf, normalizeConfig, parseAddress } from '../src/config.js';
import { SPA_CAP } from '../src/constants.js';

test('the address: IPv4 or host name, port 4257 unless given, a pasted URL reduced', () => {
  assert.deepEqual(parseAddress(' 192.168.1.80 '), { host: '192.168.1.80', port: 4257 });
  assert.deepEqual(parseAddress('http://192.168.1.80/x'), { host: '192.168.1.80', port: 4257 });
  assert.deepEqual(parseAddress('192.168.1.80:4300'), { host: '192.168.1.80', port: 4300 });
  assert.deepEqual(parseAddress('BWGSpa'), { host: 'bwgspa', port: 4257 });
  for (const bad of [
    '',
    '300.1.1.1',
    '1.2.3',
    'a b',
    'x:0',
    'x:70000',
    '-x',
    'a_b',
    'u:p@h',
    '[::1]',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  assert.equal(normalizeConfig({ address: 'a_b' }).invalid, 'a_b');
  assert.equal(normalizeConfig({ address: '' }).address, undefined);
});

test('heating and pumps are allowed by true only; lights unless false', () => {
  const c = normalizeConfig({});
  assert.equal(c.allowHeating, false);
  assert.equal(c.allowJets, false);
  assert.equal(c.allowLights, true);
  assert.equal(normalizeConfig({ allow_heating: true }).allowHeating, true);
  assert.equal(normalizeConfig({ allow_jets: 'true' }).allowJets, true);
  for (const value of [1, '1', 'yes', 'TRUE', {}, [], null, undefined, false, 'false']) {
    assert.equal(normalizeConfig({ allow_heating: value }).allowHeating, false, String(value));
    assert.equal(normalizeConfig({ allow_jets: value }).allowJets, false, String(value));
  }
  assert.equal(normalizeConfig({ allow_lights: false }).allowLights, false);
  assert.equal(normalizeConfig({ allow_lights: 'false' }).allowLights, false);
});

test('the setpoint ceiling: 38 °C by default, half degrees from 30 to 40, never above 40', () => {
  assert.equal(normalizeConfig({}).cap, SPA_CAP.default);
  assert.equal(SPA_CAP.default, 38);
  assert.equal(SPA_CAP.max, 40);
  assert.equal(capOf(39), 39);
  assert.equal(capOf('39.5'), 39.5);
  assert.equal(capOf(39.7), 39.5, 'rounded down, never up');
  assert.equal(capOf(41), 40);
  assert.equal(capOf(1e9), 40);
  assert.equal(capOf(20), 30);
  for (const value of [
    '',
    ' ',
    null,
    undefined,
    'abc',
    Number.NaN,
    Infinity,
    {},
    [],
    true,
    '1e3',
  ]) {
    assert.equal(capOf(value), 38, String(value));
  }
});

test('language fr or en, unknown keys ignored, no prototype pollution', () => {
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  assert.equal(normalizeConfig({ language: 'en' }).language, 'en');
  const polluted = normalizeConfig(JSON.parse('{"__proto__":{"allow_heating":true}}'));
  assert.equal(polluted.allowHeating, false);
  assert.equal({}.allow_heating, undefined);
});
