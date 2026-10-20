# gladys-balboa

[Gladys Assistant](https://gladysassistant.com) external integration for
**Balboa** spas with a **BWA Wi-Fi module**, over the local network (TCP
4257): water temperature, setpoint, heat mode, pumps, blowers, lights,
filter cycles. The heating and the pumps are behind off-by-default options;
the setpoint is capped at 38 °C by default and never above 40 °C. **Never
tested with a real spa. Not affiliated with Balboa Water Group.** The local
protocol is not documented and has no authentication: keep the module on a
trusted network.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (BalboaApp)
                                  ├─ src/balboa/client.js    TCP connection (node:net), frames in/out
                                  ├─ src/balboa/frame.js     frame reader/encoder, CRC-8 (pybalboa)
                                  ├─ src/balboa/protocol.js  messages: status, configuration... (pybalboa)
                                  ├─ src/devices.js          the device and its states (pure)
                                  └─ src/publisher.js        states within 300/min
```

- **Connection**: one TCP connection kept open; the spa streams its status
  (about once a second). On connect: "device present" (module
  identification, MAC address), system information (model), setup
  parameters (setpoint ranges) and device configuration (pumps, lights...),
  asked again every 10 s while missing (6 times per connection). "Device
  present" after 15 s of silence, connection dropped after 45 s; failures
  retried after 10 s, 30 s, 1, 2, 5 min.
- **Frames**: `0x7E L ... crc 0x7E`, length 5 to 64, both delimiters and
  the CRC-8 checked; anything else is skipped byte by byte (linear), and
  more than 4096 bytes without a valid frame drop the connection. 50 frames
  per second at most are handled.
- **Device**: `ext:<selector>:balboa:<mac>`; features from the device
  configuration, never lost on a republication. Water temperature
  `temperature-sensor/probe` °C (sent every 10–15 s), setpoint
  `thermostat/target-temperature` 10–40 °C, heat mode and pumps/blowers
  `text/select`, lights `light/binary`, the rest read-only
  `unknown/binary` or `text/text`. Never a switch.
- **Commands**: heating (setpoint, "Ready") behind `allow_heating`, pumps and
  blowers behind `allow_jets`, both off; light on behind `allow_lights`
  (on). "Off", "Rest" and light off are never refused by an option and
  cancel a non-protective command still running. Decided on a status
  received after the click (2 s at most); options and ceiling checked again
  right before each frame (`beforeSend`); frames leave by 3.5 s or not at
  all; the effect awaited until 4.3 s, else "sent, without confirmation".
  Toggles go one at a time, each after a status showed the previous one; a
  guard (until a status shows the effect, 20 s at most) prevents a second
  press on an unknown outcome. One command at a time.

## Credits

The protocol (frames, checksum, messages, toggles) is ported from
[pybalboa](https://github.com/natekspencer/pybalboa) (Nathan Spencer, Tim
Rightnour and contributors, Apache-2.0, 1.1.4), the library of Home
Assistant's Balboa integration; its captures are used as test data. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Structure modelled on the
sibling integrations [gladys-iaqualink](https://github.com/LM1LC3N7/gladys-iaqualink)
(pool and spa) and [gladys-stiebel-eltron](https://github.com/LM1LC3N7/gladys-stiebel-eltron)
(local TCP, capped setpoint).

## Development

```bash
npm install
npm test                                        # node --test, no network but loopback
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

The spa is a fake behind the injected socket factory
(`test/helpers/fakeSpa.js`), Gladys is the SDK's fake;
`test/client.test.js` runs the real transport against a loopback server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an Apache-2.0 project,
credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in
the Docker image).
