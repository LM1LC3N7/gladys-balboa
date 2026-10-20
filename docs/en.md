# Balboa Spa for Gladys

Shows your **Balboa** spa in Gladys over your local network, through the
**BWA Wi-Fi module** (the one of the Balboa Worldwide App), without any
cloud: water temperature, setpoint, heat mode, pumps, blowers, lights,
filter cycles and circulation pump.

**Never tested with a real spa.** The local protocol is not documented by
Balboa: this integration follows what
[pybalboa](https://github.com/natekspencer/pybalboa) (the library of Home
Assistant's Balboa integration) does. Not affiliated with Balboa Water Group.

## Before you start

- A Balboa controller (BP, GS, EL series…) with a **BWA Wi-Fi module**
  (BWG), connected to your Wi-Fi.
- The **IP address** of the module: look for it in your router (often named
  `BWGSpa`) and give it a fixed address (DHCP reservation).
- The module talks on TCP port **4257**, without a password: keep it on a
  **trusted network** (no port forwarding from the internet).
- The module accepts few connections at once: if Gladys cannot connect,
  close the Balboa app on the local network, and do not run Home
  Assistant's Balboa integration on the same spa at the same time.

## Setup

1. Install the integration from the store.
2. In its configuration, enter the **IP address of the Wi-Fi module**
   (for example `192.168.1.80`; another port can be added as
   `192.168.1.80:4257`), then save.
3. "Test the connection" shows the state: "Connected: Balboa BP501G1."
4. In the **Discovery** tab, add the spa.

## What you get

| Feature               | Type                                 | Notes                                  |
| --------------------- | ------------------------------------ | -------------------------------------- |
| Water temperature     | temperature (°C)                     | Sent at most every 10 to 15 s          |
| Setpoint              | thermostat (°C)                      | Command, see "Heating"                 |
| Heating               | read only, 0/1                       | 1 while the heater runs                |
| Heat mode             | list: Ready / Rest                   | Command, see "Heating"                 |
| Spa status            | text                                 | State, heat mode, heating, Wi-Fi notes |
| Temperature range     | text                                 | Low / High (read only)                 |
| Filter cycles 1 and 2 | read only, 0/1                       | 1 while running                        |
| Circulation pump      | read only, 0/1                       | When the spa has one                   |
| Pumps 1 to 8          | list: Off / Low / High (or Off / On) | Pumps 1–6 commandable, 7–8 read only   |
| Blowers               | list                                 | Commandable                            |
| Lights                | light on/off                         | Commandable                            |
| Auxiliaries, misters  | read only, 0/1                       | When the spa has them                  |

A spa set to °F is shown in °C. The features follow the device
configuration the spa reports; a feature never disappears from a device
already created.

## Heating

Off by default: turn on **"Allow the heating commands"** to let Gladys
change the **setpoint** and put the heat mode on **"Ready"**.

- **Setpoint ceiling**: Gladys never sets the spa above it. **38 °C by
  default**, configurable from 30 to 40 °C, **never above 40 °C** (the limit
  of spa standards), whatever is typed. Steps of 0.5 °C; the spa must accept
  the value in its current range (low range: 10–37 °C, high range:
  26.5–40 °C by default).
- **"Rest"** (heats during filtration only) is always allowed: it lowers
  the heating.
- The temperature range (low/high) is read only.

## Pumps and blowers

Off by default: turn on **"Allow the pumps"** to start the jets. **"Off"
is always accepted** (a stop is never refused, and cancels a pump command
still running). They are lists, never on/off switches: a "turn everything
off" of a voice assistant or a scene cannot reach them.

The spa only knows "next speed" presses: Gladys sends one press at a time
and waits for the spa to show it before the next one (Low → High → Off for
a two-speed pump).

## Lights

On and off by default. Turn off **"Allow turning the lights on"** to only
let Gladys turn them off.

## How commands behave

- Each command waits for a status the spa sends **after** your click (the
  spa sends one about every second): nothing is decided on an old state.
- The options and the ceiling are checked again right before each frame
  leaves.
- A frame is sent within 3.5 s of the click or not at all. If the spa does
  not show the change by 4.3 s, the answer is **"Command sent, without
  confirmation"**: check the spa a few seconds later. Gladys never sends the
  same press again on an unknown outcome (for 20 s, until the spa shows it).
- One command at a time.

## Troubleshooting

- "No connection to the spa": check the IP address, that the module is on
  your network, and that no other app keeps it busy. Gladys tries again
  after 10 s, 30 s, 1, 2, then every 5 minutes.
- "Connected to the Wi-Fi module, waiting for the spa…": the module answers
  but the spa sends nothing yet (spa starting, or the module lost the spa).
- The status shows "the spa does not answer the module": the module reports
  that it cannot talk to the spa controller.

## Privacy

Everything stays on your local network. No account, no cloud, no password.
The MAC address of the module is the identifier of the device in Gladys; it
is never written in the logs.
