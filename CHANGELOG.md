# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Balboa spas with a BWA Wi-Fi module, over the local network (TCP 4257, no
  cloud, no account), by the IP address of the module; the protocol of
  pybalboa (the library of Home Assistant's Balboa integration).
- One device per spa (identified by the MAC address of its module): water
  temperature, setpoint, heating, heat mode, spa status, temperature range,
  filter cycles, circulation pump, pumps, blowers, lights, auxiliaries and
  misters, as the spa's device configuration reports them; always in °C.
- Heating commands behind "Allow the heating commands" (off by default):
  the setpoint, never above the configured ceiling (38 °C by default, 30 to
  40 °C) nor 40 °C, and the "Ready" heat mode. "Rest" is always allowed.
- Pumps and blowers as lists (never switches) behind "Allow the pumps" (off
  by default); "Off" is always allowed and cancels a pump command still
  running. Lights on/off, turning them on can be disabled.
- Every command is decided on a status received after the click, checks
  the options and the ceiling again right before each frame, sends its
  presses one at a time (each after a status showed the previous one),
  leaves within 3.5 s or not at all, and answers "sent, without
  confirmation" when the spa does not show the change by 4.3 s.
- Own frame reader: bounded frames (length 5 to 64), both delimiters and the
  checksum checked, the connection dropped on a stream that is not a spa.
- Keep-alive after 15 s of silence, reconnection after 45 s; failures
  retried after 10 s to 5 minutes.
- A republished device never loses a feature; status, Discovery and badge
  sent again at every reconnection to Gladys.
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-balboa/commits/main
