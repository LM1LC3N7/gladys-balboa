// -----------------------------------------------------------------------------
// The TCP connection to the BWA Wi-Fi module of the spa (port 4257), on
// node:net. The spa talks first and often: it streams its status (about
// once a second) and answers the requests with other frames; nothing it
// sends is the answer of one request in particular. So this connection only:
//   - opens the socket (5 s at most) and drops it on request;
//   - cuts the stream into checked frames (src/balboa/frame.js) and hands
//     them over, LIMITS.framesPerSecond at most per second;
//   - drops the connection when the stream is not a Balboa one (too many
//     bytes that are not a valid frame);
//   - writes a frame, after a last check (`beforeSend`) run right before the
//     bytes leave: what it throws is rethrown with `beforeSend: true` and
//     nothing is written. Once written, a frame may reach the spa (`sent`).
// -----------------------------------------------------------------------------

import net from 'node:net';
import { LIMITS, SECOND, TIMINGS } from '../constants.js';
import { FrameReader, encode } from './frame.js';

export const ERROR_KINDS = {
  /** No TCP connection could be opened: nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** The connection closed (or is not open). */
  CLOSED: 'closed',
  /** The stream is not a Balboa one (the connection is dropped). */
  PROTOCOL: 'protocol',
  /** The spa stopped talking (the connection is dropped). */
  SILENT: 'silent',
};

export class BalboaError extends Error {
  constructor(kind, { sent = false } = {}) {
    super(kind);
    this.name = 'BalboaError';
    this.kind = kind;
    this.sent = sent;
  }
}

/** A short reason for the logs and the messages: our own words only. */
export function errorReason(err) {
  return err instanceof BalboaError ? err.kind : 'error';
}

export class BalboaConnection {
  constructor({
    host,
    port,
    connect = (options) => net.createConnection(options),
    timers = globalThis,
    now = Date.now,
    onFrame = () => {},
    onClose = () => {},
  }) {
    this.host = host;
    this.port = port;
    this.connect = connect;
    this.timers = timers;
    this.now = now;
    this.onFrame = onFrame;
    this.onClose = onClose;
    this.socket = undefined;
    this.reader = new FrameReader();
    this.closed = false;
    this.window = { start: 0, count: 0 };
    this.lastSentAt = undefined;
  }

  get isOpen() {
    return Boolean(this.socket && !this.socket.destroyed && this.socket.writable !== false);
  }

  /** Opens the socket; rejects UNREACHABLE (nothing sent) after TIMINGS.connectTimeout. */
  open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      const timer = this.timers.setTimeout(() => {
        if (!settled) {
          settled = true;
          socket?.destroy();
          reject(new BalboaError(ERROR_KINDS.UNREACHABLE));
        }
      }, TIMINGS.connectTimeout);
      const fail = () => {
        if (!settled) {
          settled = true;
          this.timers.clearTimeout(timer);
          socket?.destroy();
          reject(new BalboaError(ERROR_KINDS.UNREACHABLE));
        }
      };
      try {
        socket = this.connect({ host: this.host, port: this.port });
      } catch {
        fail();
        return;
      }
      socket.on('error', () => {
        // Before 'connect': unreachable; after: the 'close' that follows tells.
        fail();
      });
      socket.once('close', fail);
      socket.once('connect', () => {
        if (settled) {
          return;
        }
        settled = true;
        this.timers.clearTimeout(timer);
        if (this.closed) {
          socket.destroy();
          reject(new BalboaError(ERROR_KINDS.UNREACHABLE));
          return;
        }
        socket.setNoDelay?.(true);
        this.socket = socket;
        socket.on('data', (chunk) => this.receive(socket, chunk));
        socket.on('close', () => {
          if (this.socket === socket) {
            this.drop(new BalboaError(ERROR_KINDS.CLOSED, { sent: true }));
          }
        });
        resolve();
      });
    });
  }

  receive(socket, chunk) {
    if (socket !== this.socket || !Buffer.isBuffer(chunk)) {
      return;
    }
    const frames = this.reader.feed(chunk);
    if (this.reader.flooded) {
      this.drop(new BalboaError(ERROR_KINDS.PROTOCOL, { sent: true }));
      return;
    }
    for (const frame of frames) {
      const now = this.now();
      if (now - this.window.start >= SECOND) {
        this.window = { start: now, count: 0 };
      }
      this.window.count += 1;
      if (this.window.count > LIMITS.framesPerSecond) {
        continue;
      }
      try {
        this.onFrame(frame);
      } catch {
        // A handler error never breaks the stream.
      }
      if (socket !== this.socket) {
        return;
      }
    }
  }

  /**
   * Writes one message. Throws CLOSED when there is no connection (nothing
   * sent); `beforeSend` runs right before the bytes leave.
   */
  send(type, payload = [], { beforeSend } = {}) {
    const frame = encode(type, payload);
    if (!this.isOpen) {
      throw new BalboaError(ERROR_KINDS.CLOSED);
    }
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        err.beforeSend = true;
        throw err;
      }
    }
    this.lastSentAt = this.now();
    // From here the frame may reach the spa.
    this.socket.write(frame);
  }

  /** Drops the connection for good (a stop, another address). */
  close() {
    this.closed = true;
    this.drop(new BalboaError(ERROR_KINDS.CLOSED, { sent: true }));
  }

  /** Closes the socket; `onClose(err)` once per connection. */
  drop(err) {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.socket = undefined;
    this.reader = new FrameReader();
    socket.destroy();
    try {
      this.onClose(err);
    } catch {
      // Never thrown back into the socket.
    }
  }
}
