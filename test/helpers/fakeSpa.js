// -----------------------------------------------------------------------------
// A fake Balboa spa behind the socket factory: it reads the frames the client
// writes (its own frame parser, checksum from pybalboa's fixtures), answers
// the requests, applies the toggles and the setpoint, and streams its status
// when the test moves the clock (`spa.tick(ms)`, about once a second). No
// network: every socket is an in-memory EventEmitter.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { checksum } from '../../src/balboa/frame.js';

export const HOST = '192.168.1.80';
export const MAC = '001527735be2';
export const NOW = Date.UTC(2026, 9, 20, 18, 0, 0);

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** A frame as the spa sends it: header bytes, type, payload. */
export function spaFrame(type, payload, header = [0x0a, 0xbf]) {
  const head = [payload.length + 5, ...header, type, ...payload];
  return Buffer.from([0x7e, ...head, checksum(head), 0x7e]);
}

/** Pump 1 two speeds, pump 2 one speed, light 1, a circulation pump. */
export const DEVICE_CONFIGURATION = [0x06, 0x00, 0x01, 0x80, 0x00, 0x00];

export function fakeSpa({
  celsius = true,
  configuration = DEVICE_CONFIGURATION,
  model = 'BP501G1',
} = {}) {
  const spa = {
    celsius,
    /** In the unit of the spa (half degrees in °C). */
    temperature: celsius ? 74 : 99,
    target: celsius ? 76 : 100,
    heatMode: 0,
    range: 1,
    heatState: 1,
    filter1: 1,
    pumps: [0, 0, 0, 0, 0, 0, 0, 0],
    lights: [0, 0, 0, 0],
    circulation: 1,
    configuration: [...configuration],
    mac: MAC,
    model,
    /** Frames received: { type, payload: number[] }. */
    received: [],
    connects: [],
    sockets: [],
    down: false,
    /** Statuses stop (a spa that went quiet). */
    quiet: false,
    /** Toggles and setpoints are received but not applied. */
    ignore: false,
    /** Requests are not answered. */
    mute: false,
    interval: 1_000,
    elapsed: 0,
  };

  const statesOfPump = (index) => {
    const c = spa.configuration;
    const values = [
      c[0] & 3,
      (c[0] >> 2) & 3,
      (c[0] >> 4) & 3,
      (c[0] >> 6) & 3,
      c[1] & 3,
      (c[1] >> 6) & 3,
      (c[1] >> 4) & 3,
      (c[1] >> 2) & 3,
    ];
    return values[index] + 1;
  };

  spa.statusPayload = () => {
    const d = Buffer.alloc(24);
    d[0] = 0;
    d[2] = spa.temperature;
    d[3] = 18;
    d[4] = Math.floor(spa.elapsed / 60_000) % 60;
    d[5] = spa.heatMode;
    d[9] = (spa.celsius ? 1 : 0) | (spa.filter1 << 2);
    d[10] = (spa.range << 2) | (spa.heatState << 4);
    d[11] = spa.pumps.slice(0, 4).reduce((acc, v, i) => acc | (v << (i * 2)), 0);
    d[12] = spa.pumps.slice(4).reduce((acc, v, i) => acc | (v << (i * 2)), 0);
    d[13] = spa.circulation << 1;
    d[14] = spa.lights.reduce((acc, v, i) => acc | ((v ? 3 : 0) << (i * 2)), 0);
    d[20] = spa.target;
    return d;
  };

  const write = (socket, buffer) => {
    setImmediate(() => {
      if (!socket.destroyed) {
        socket.emit('data', buffer);
      }
    });
  };

  spa.broadcast = () => {
    for (const socket of spa.sockets) {
      write(socket, spaFrame(0x13, [...spa.statusPayload()], [0xff, 0xaf]));
    }
  };

  /** Raw bytes to every connected socket. */
  spa.inject = (bytes) => {
    for (const socket of spa.sockets) {
      write(socket, Buffer.from(bytes));
    }
  };

  /** The test clock moved: a status about every second. */
  spa.tick = (ms) => {
    const before = Math.floor(spa.elapsed / spa.interval);
    spa.elapsed += ms;
    if (!spa.quiet && Math.floor(spa.elapsed / spa.interval) > before) {
      spa.broadcast();
    }
  };

  const answer = (socket, type, payload) => write(socket, spaFrame(type, payload));

  const handle = (socket, type, payload) => {
    spa.received.push({ type, payload });
    if (type === 0x04) {
      if (!spa.mute) {
        const mac = Buffer.from(spa.mac, 'hex');
        answer(socket, 0x94, [0x02, 0x14, 0x80, ...mac, ...Buffer.alloc(16, 0x11)]);
      }
      return;
    }
    if (type === 0x22) {
      if (spa.mute) {
        return;
      }
      if (payload[0] === 0x02) {
        const name = Buffer.from(spa.model.padEnd(8, ' ').slice(0, 8), 'latin1');
        answer(socket, 0x24, [100, 201, 20, 0, ...name, 1, 0, 0, 0, 0, 1, 10, 0, 0]);
      } else if (payload[0] === 0x04) {
        answer(socket, 0x25, [6, 1, 50, 99, 80, 104, 9, 3, 0x41]);
      } else if (payload[0] === 0x00) {
        answer(socket, 0x2e, spa.configuration);
      }
      return;
    }
    if (spa.ignore) {
      return;
    }
    if (type === 0x20) {
      spa.target = payload[0];
      return;
    }
    if (type === 0x11) {
      const code = payload[0];
      if (code >= 0x04 && code <= 0x09) {
        const i = code - 0x04;
        spa.pumps[i] = (spa.pumps[i] + 1) % statesOfPump(i);
      } else if (code >= 0x11 && code <= 0x14) {
        spa.lights[code - 0x11] = spa.lights[code - 0x11] ? 0 : 1;
      } else if (code === 0x51) {
        spa.heatMode = spa.heatMode === 0 ? 1 : spa.heatMode === 1 ? 0 : 1;
      }
    }
  };

  /** Our own reader of what the client writes: 7E L ... crc 7E, checked. */
  const receive = (socket, data) => {
    socket.inbox = Buffer.concat([socket.inbox, data]);
    while (socket.inbox.length >= 2) {
      if (socket.inbox[0] !== 0x7e) {
        throw new Error(`fake spa: bad start ${socket.inbox.toString('hex')}`);
      }
      const length = socket.inbox[1];
      if (socket.inbox.length < length + 2) {
        return;
      }
      const frame = socket.inbox.subarray(0, length + 2);
      socket.inbox = socket.inbox.subarray(length + 2);
      const body = frame.subarray(1, length);
      if (frame[length + 1] !== 0x7e || checksum(body) !== frame[length]) {
        throw new Error(`fake spa: bad frame ${frame.toString('hex')}`);
      }
      if (body[1] !== 0x0a || body[2] !== 0xbf) {
        throw new Error(`fake spa: bad header ${frame.toString('hex')}`);
      }
      handle(socket, body[3], [...body.subarray(4)]);
    }
  };

  spa.connect = ({ host, port }) => {
    spa.connects.push({ host, port });
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.writable = true;
    socket.inbox = Buffer.alloc(0);
    socket.setNoDelay = () => {};
    socket.destroy = () => {
      if (!socket.destroyed) {
        socket.destroyed = true;
        spa.sockets = spa.sockets.filter((s) => s !== socket);
        setImmediate(() => socket.emit('close'));
      }
    };
    socket.write = (data) => {
      if (!socket.destroyed) {
        receive(socket, Buffer.from(data));
      }
      return true;
    };
    setImmediate(() => {
      if (spa.down) {
        socket.destroyed = true;
        socket.emit(
          'error',
          Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        );
        socket.emit('close');
      } else {
        spa.sockets.push(socket);
        socket.emit('connect');
      }
    });
    return socket;
  };

  /** The commands received (toggles and setpoints): [type, ...payload]. */
  spa.commands = () =>
    spa.received
      .filter((f) => f.type === 0x11 || f.type === 0x20)
      .map((f) => [f.type, ...f.payload]);
  return spa;
}
