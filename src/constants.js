// -----------------------------------------------------------------------------
// Constants: the Balboa local protocol, manifest keys, feature roles, limits
// and timings.
//
// A Balboa spa with a BWA Wi-Fi module (BWG) answers on TCP port 4257 of the
// local network, without authentication, with the frames pybalboa reads (the
// library of Home Assistant's Balboa integration). The protocol is not
// documented by Balboa: everything here comes from pybalboa 1.1.4, and every
// frame is checked and bounded (src/balboa/frame.js).
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 4257;

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  WATER_TEMPERATURE: 'water-temperature',
  TARGET_TEMPERATURE: 'target-temperature',
  HEATING: 'heating',
  HEAT_MODE: 'heat-mode',
  STATUS: 'status',
  TEMPERATURE_RANGE: 'temperature-range',
  FILTER_1: 'filter-cycle-1',
  FILTER_2: 'filter-cycle-2',
  CIRCULATION_PUMP: 'circulation-pump',
  /** `pump-1` to `pump-8`. */
  PUMP: 'pump',
  /** `blower-1`, `blower-2`. */
  BLOWER: 'blower',
  /** `light-1` to `light-4`. */
  LIGHT: 'light',
  /** `aux-1` to `aux-4` (read only). */
  AUX: 'aux',
  /** `mister-1` to `mister-3` (read only). */
  MISTER: 'mister',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/**
 * The spa setpoint Gladys may send, in °C. 40 °C is the ceiling of spa
 * standards (and of the Balboa high range, 104 °F): nothing above it is ever
 * sent, whatever the configuration says. The configuration chooses the
 * ceiling between `min` and `max`, 38 °C by default.
 */
export const SPA_CAP = {
  min: 30,
  max: 40,
  default: 38,
};

/** The setpoint feature of Gladys: its slider (°C), frozen at creation. */
export const SETPOINT_FEATURE = { min: 10, max: SPA_CAP.max };

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /**
   * The length byte of a frame: 5 (length, 3 header bytes, checksum) to 64.
   * The longest message pybalboa reads is 30 (module identification); a
   * longer "frame" is not one (0x7E, a delimiter, is never a length).
   */
  frameMinLength: 5,
  frameMaxLength: 64,
  /**
   * Bytes dropped (not a valid frame) since the last valid one, after which
   * the connection is dropped: a stream that is not a Balboa spa.
   */
  junkBytes: 4096,
  /** Valid frames in one second beyond which the extra ones are ignored. */
  framesPerSecond: 50,
  /** A model name: 8 characters in the system information. */
  modelLength: 8,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

export const TIMINGS = {
  /** Opening the TCP connection to the Wi-Fi module. */
  connectTimeout: 5 * SECOND,
  /** Silence after which a "device present" is sent (pybalboa: 15 s). */
  keepAlive: 15 * SECOND,
  /** Silence after which the connection is dropped and opened again. */
  silence: 45 * SECOND,
  /** The watchdog runs every few seconds. */
  watchdog: 5 * SECOND,
  /** The configuration asked again (what did not come) at most this often, a few times. */
  configRetry: 10 * SECOND,
  configRetries: 6,
  /** Failed connections: 10 s, 30 s, 1, 2, then 5 minutes. */
  backoff: [10 * SECOND, 30 * SECOND, 60 * SECOND, 2 * MINUTE, 5 * MINUTE],
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The water temperature and the clock change often: states queued at most this often. */
  statesEvery: 10 * SECOND,
  /** The "Test the connection" button. */
  testCooldown: 10 * SECOND,
  testWait: 8 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): a status received after the
   * click is awaited 2 s at most; every frame leaves by 3.5 s after the click
   * or is not sent; the effect is awaited until 4.3 s, after which the
   * command is "sent, without confirmation".
   */
  commandFreshBy: 2_000,
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** A toggle sent keeps its guard until a status shows its effect, or 20 s. */
  guard: 20 * SECOND,
};
