# TODO — Balboa Spa v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  (lot 10) gets one recap message in /t/10385.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-20): local TCP connection to the BWA
      module, own bounded frame reader, status, configuration, one device,
      heating behind `allow_heating` (off) with the ceiling (38 °C, 30–40,
      never above 40), pumps and blowers as lists behind `allow_jets`
      (off), lights, keep-alive and reconnection, test button, docs en/fr,
      cover. Tested against a fake spa and pybalboa's captures only.
- [ ] **Milestone 2 — real spa**: run against a real spa (see "To check"),
      turn captures (without the MAC) into fixtures.
- [ ] **Milestone 3 — more**: temperature range command (low/high) once the
      setpoint the spa restores on a range change is known (it could be
      above the ceiling); filter cycle schedule (read, then set behind an
      option); fault log as a text; UDP discovery (port 30303) when the
      container can receive broadcasts; aux/mister commands behind their
      own option; clock sync.

## To check on a real spa

- The status cadence (about once a second?): commands wait 2 s at most for
  a status sent after the click.
- The toggle frame: pybalboa sends one byte (item code); some other
  implementations send two (code, 0x00). Check the spa reacts.
- That a toggle shows in the next status or two (each press of a
  multi-step command waits for it, by 4.3 s after the click).
- The heat mode cycle (ready → rest → ready; "ready in rest" → rest → ready).
- How many TCP clients the module accepts (Balboa app, Home Assistant).
- Whether the module answers "device present" when the spa is idle (the
  keep-alive), and the longest message it sends (frames above 64 bytes of
  length are rejected).
- Blower and circulation bits of the status (pybalboa reads the blower from
  bits 1–2 and 3–4 of byte 13, overlapping the circulation pump bit).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-balboa:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the four
  agree.
- **Reference**: pybalboa 1.1.4 (Apache-2.0, Nathan Spencer and Tim
  Rightnour, the library of Home Assistant's Balboa integration), cloned
  read only in `_ref/pybalboa` (main b1b9335; the protocol code is the same
  as tag 1.1.4, a2d48d0). License checked in its `LICENSE` (Apache-2.0, no
  `NOTICE` file). Credited in README, docs and `THIRD_PARTY_NOTICES.md` (full
  license text), shipped in the image with `LICENSE` (the standard
  Apache-2.0 text without any name). Its captures are test data.
- **Sibling modules** read (read only): gladys-iaqualink (pool/spa, the
  neighbour of the proposal: toggles and guards) and gladys-stiebel-eltron
  (local TCP, capped setpoint, `beforeSend`, connection rules).
- **Own TCP client and frame reader, no dependency**: no maintained npm
  package for the Balboa protocol; about 400 lines on `node:net`.
- **Undocumented protocol, bounded frames**: length 5 to 64 (pybalboa's
  longest message is 30; 0x7E is a delimiter, never a length), both
  delimiters and the CRC-8 checked, linear scan (each start byte tried once
  over at most 64 bytes), buffer of one incomplete frame (66 bytes), more
  than 4096 bytes without a valid frame drop the connection (the rest of the
  chunk is not scanned), 50 frames per second at most handled. Short
  payloads are ignored, never read past their end; a model name keeps
  printable ASCII only; temperatures outside −20–80 °C are unknown.
- **One spa per integration, identified by the module MAC** (module
  identification): the IP address may change. Another MAC at the same
  address drops what was learnt. The MAC is never logged.
- **Features and units**: water temperature `temperature-sensor/probe` °C
  (sent every 10–15 s: it moves slowly and the status comes every second);
  setpoint `thermostat/target-temperature` °C, slider 10–40 (frozen at
  creation; the configured ceiling refuses above it); heat mode `text/select`
  ready/rest ("ready in rest" shown as rest, and in the status text);
  pumps 1–6 and blowers `text/select` with the speeds of the device
  configuration (off/on, off/low/high, off/low/medium/high); pumps 7–8
  `text/text` read only (no toggle code in pybalboa); lights `light/binary`;
  heating, filter cycles, circulation pump, auxiliaries, misters
  `unknown/binary` read only; spa status and temperature range `text/text`.
  Always °C: a °F spa is converted (one decimal), setpoints sent in °F are
  whole °F whose °C value stays under the ceiling.
- **No switch** (lot 6 lesson): pumps, blowers and heating are never a
  `switch` nor a writable binary. Lights are `light/binary` (harmless, and
  turning them on can be disabled).
- **Options**: `allow_heating` (setpoint and "Ready") and `allow_jets`
  (pumps and blowers not off) off by default, only `true` allows;
  `allow_lights` on by default, only `false` disables (turning on).
  **Protective commands** never refused by an option: pump/blower "off",
  heat mode "rest", light off; they cancel a non-protective command still
  running (its next wait or frame stops: "Cancelled by a stop command", or
  "sent, without confirmation" if a frame already left).
- **Setpoint ceiling** `max_temperature`: 38 °C by default, 30–40 °C, half
  degrees rounded down, anything not a number gives 38, never above 40 °C
  (spa standards, Balboa's high range 104 °F). Checked on arrival, against
  the spa's current range (setup parameters, else pybalboa's defaults), and
  again right before the frame (a ceiling lowered meanwhile stops it).
- **Command rules** (lot 6 and waves 2/3 lessons): decided on a status
  received after the click (2 s at most), never on the one in memory;
  refused when the value is missing or the equipment unknown; not sent when
  already so; options, ceiling, connection and spa checked again in
  `beforeSend`; every frame leaves by 3.5 s after the click or is refused
  unsent; the effect awaited in the statuses until 4.3 s, else "Command
  sent, without confirmation" (the protocol has no acknowledgement); one
  command at a time ("still running" for a second one, unless a stop); the
  ack never waits for a publication.
- **Toggles**: pybalboa sends as many presses as needed at once; here one
  press at a time, the next only after a status showed the previous one
  (at most states − 1 presses; 2 for the heat mode). **Guards**: after every
  frame, until a status shows another value than the one before it (never
  lifted on an unknown or equal value), 20 s at most: a command asking the
  same target answers at once, another is refused ("not confirmed yet"); a
  stop waits for the guard (within its 3.5 s) and decides on the status
  after it.
- **Temperature range** read only in v1: switching range makes the spa
  restore the setpoint of the other range, which could be above the
  ceiling.
- **Connection**: keep-alive "device present" after 15 s of silence;
  dropped after 45 s without any frame; failures retried after 10 s, 30 s,
  1, 2, 5 min (no 429 nor credentials here: nothing kept in `/data`). The
  configuration is asked again every 10 s while missing, 6 times per
  connection.
- **Reconnection to Gladys** (`connected`): republishes status, Discovery,
  states (published-state memory forgotten) and badge (lot 6 lesson); the
  spa connection stays. A new address restarts; the options, the ceiling
  and the language apply at once.
- **No energy, no scene event, no secret**: nothing published as an index,
  nothing kept as a secret, no `publishSceneEvent`.
- **gladys_version >= 5.1.0** (as the sibling local modules); **categories
  `appliances`, `climate`**, transport `local`.
- **Template demo files** (devices, scenes, widgets, weather and their tests)
  removed.
- **Not checked here**: the store validator (`npx
github:GladysAssistant/integration-store .`) cannot be run by the
  development agent: it runs at publication (main session). No Docker on
  this PC: the image was not built locally.
