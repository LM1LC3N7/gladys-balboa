# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency (the spa is reached through our own TCP client on
`node:net`). It connects to the BWA Wi-Fi module of a Balboa spa on the
local network (TCP 4257, no cloud, no authentication, an undocumented
protocol ported from pybalboa) and shows the spa as one Gladys device; the
heating and the pumps can be commanded behind off-by-default options, the
setpoint capped. Never tested with a real spa, not affiliated with Balboa.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` (Node 22 and 24) and `audit` before every
commit.

## Architecture

```
index.js                  SDK bootstrap only
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                BalboaApp: connection, watchdog, frames, device, states,
                          badge, status, test button, commands, guards
src/balboa/client.js      TCP connection (node:net): open, frames in, send + beforeSend
src/balboa/frame.js       frame reader (bounded, checked) and encoder, CRC-8
src/balboa/protocol.js    message types and parsers (pybalboa)
src/devices.js            -> the Gladys device and its states (pure), kept features
src/publisher.js          states within 300/min
src/config.js             config_schema normalized (address, allow_heating,
                          max_temperature, allow_jets, allow_lights, language)
src/constants.js          feature roles, limits, timings, the setpoint ceiling
src/i18n.js               runtime texts, feature and option names (en/fr)
test/helpers/fakeSpa.js   the fake spa behind the socket factory; Gladys is the SDK's fake
scripts/cover.mjs         cover.png generator
```

## Rules

- **External ids are forever**: device `balboa:<mac>` (12 hex digits of the
  module MAC), features `water-temperature`, `target-temperature`,
  `heating`, `heat-mode`, `status`, `temperature-range`, `filter-cycle-1`,
  `filter-cycle-2`, `circulation-pump`, `pump-1`…`pump-8`, `blower-1`,
  `blower-2`, `light-1`…`light-4`, `aux-1`…`aux-4`, `mister-1`…`mister-3`.
  A republished device never loses a feature (`keepCreatedFeatures`).
- Manifest keys (`address`, `allow_heating`, `max_temperature`,
  `allow_jets`, `allow_lights`, `language`, the action `test_connection`)
  are frozen.
- **Frames**: length 5 to 64, both delimiters and the CRC checked, linear
  scan, the buffer bounded, the connection dropped after 4096 bytes without
  a valid frame. Never trust a byte of the spa (unknown values are dropped).
- **Commands**: never a switch for pumps, blowers or heating (a "turn
  everything off" must not reach them); heating behind `allow_heating`,
  pumps behind `allow_jets` (both off); "Off", "Rest" and light off never
  refused, and they cancel a non-protective command running; decided on a
  status received after the click only; options and ceiling checked again
  right before each frame; never sent after 3.5 s; one press at a time,
  each after a status showed the previous one; no effect by 4.3 s → "sent,
  without confirmation"; guards; never retried; one command at a time; the
  ack never waits for Gladys.
- **Setpoint**: never above the configured ceiling (38 °C by default) nor
  40 °C, half degrees only.
- Never log the MAC address. Units only from the core's
  `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network (the loopback server of `test/client.test.js` aside).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
