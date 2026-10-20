// -----------------------------------------------------------------------------
// The real transport (node:net) against a loopback server: frames both ways,
// `beforeSend`, a closed port, a stream that is not a spa.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { BalboaConnection, ERROR_KINDS } from '../src/balboa/client.js';
import { spaFrame } from './helpers/fakeSpa.js';

async function server(onSocket) {
  const srv = net.createServer(onSocket);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return srv;
}

const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('frames both ways over a real socket; beforeSend stops a frame', async (t) => {
  const received = [];
  const srv = await server((socket) => {
    socket.on('data', (d) => received.push(...d));
    socket.write(spaFrame(0x13, [...Buffer.alloc(24)], [0xff, 0xaf]));
  });
  t.after(() => srv.close());
  const frames = [];
  const conn = new BalboaConnection({
    host: '127.0.0.1',
    port: srv.address().port,
    onFrame: (f) => frames.push(f),
  });
  await conn.open();
  t.after(() => conn.close());
  await until(() => frames.length === 1);
  assert.equal(frames[0].type, 0x13);
  assert.equal(frames[0].payload.length, 24);
  conn.send(0x04);
  await until(() => received.length === 7);
  assert.equal(Buffer.from(received).toString('hex'), '7e050abf04777e');
  assert.throws(
    () =>
      conn.send(0x11, [0x04], {
        beforeSend: () => {
          throw new Error('no');
        },
      }),
    (err) => err.beforeSend === true,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(received.length, 7, 'nothing written');
});

test('a closed port: unreachable, and nothing can be sent', async () => {
  const srv = await server(() => {});
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  const conn = new BalboaConnection({ host: '127.0.0.1', port });
  await assert.rejects(conn.open(), (err) => err.kind === ERROR_KINDS.UNREACHABLE);
  assert.throws(
    () => conn.send(0x04),
    (err) => err.kind === ERROR_KINDS.CLOSED && !err.sent,
  );
});

test('a stream that is not a spa: the connection is dropped (protocol)', async (t) => {
  const srv = await server((socket) => {
    socket.on('error', () => {});
    socket.write(Buffer.alloc(8192, 0x20));
  });
  t.after(() => srv.close());
  let closed;
  const conn = new BalboaConnection({
    host: '127.0.0.1',
    port: srv.address().port,
    onClose: (err) => {
      closed = err;
    },
  });
  await conn.open();
  await until(() => closed !== undefined);
  assert.equal(closed.kind, ERROR_KINDS.PROTOCOL);
  assert.equal(conn.isOpen, false);
});
