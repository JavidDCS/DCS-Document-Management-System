import net from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvScanner, DisabledScanner, ScannerUnavailableError } from '../src/modules/file-security/scanner.js';

/** A tiny clamd stand-in that speaks the INSTREAM protocol and records what it received. */
function fakeClamd(decide: (received: Buffer) => string | 'hang' | 'drop') {
  const state = { received: Buffer.alloc(0), command: '', chunks: 0 };
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let started = false;
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!started) {
        const i = buf.indexOf(0);
        if (i === -1) return;
        state.command = buf.subarray(0, i).toString();
        buf = buf.subarray(i + 1);
        started = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const reply = decide(state.received);
          if (reply === 'hang') return;
          if (reply === 'drop') return void socket.destroy();
          socket.end(`${reply}\0`);
          return;
        }
        if (buf.length < 4 + len) return;
        state.received = Buffer.concat([state.received, buf.subarray(4, 4 + len)]);
        state.chunks++;
        buf = buf.subarray(4 + len);
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise<{ port: number; state: typeof state; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, state, close: () => server.close() }))
  );
}

let closer: (() => void) | null = null;
afterEach(() => closer?.());

describe('ClamAvScanner (INSTREAM protocol)', () => {
  it('reports a clean file and sends every byte in length-prefixed chunks', async () => {
    const clamd = await fakeClamd(() => 'stream: OK');
    closer = clamd.close;
    const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 256));
    const verdict = await new ClamAvScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 5000 }).scan(Readable.from([data]));
    expect(verdict).toEqual({ clean: true });
    expect(clamd.state.command).toBe('zINSTREAM');
    expect(clamd.state.received).toEqual(data);
    expect(clamd.state.chunks).toBeGreaterThan(4);
  });

  it('reports a detection with the signature name', async () => {
    const clamd = await fakeClamd(() => 'stream: Eicar-Test-Signature FOUND');
    closer = clamd.close;
    const v = await new ClamAvScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 5000 }).scan(Readable.from([Buffer.from('X5O!P%@AP')]));
    expect(v).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
  });

  it('works with an empty file', async () => {
    const clamd = await fakeClamd(() => 'stream: OK');
    closer = clamd.close;
    expect(await new ClamAvScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 5000 }).scan(Readable.from([]))).toEqual({ clean: true });
  });

  it('treats every non-verdict as "scanner unavailable" (fail closed): ERROR reply, garbage, dropped connection, empty reply', async () => {
    for (const reply of ['stream: INSTREAM size limit exceeded. ERROR', 'something else', 'drop', '']) {
      const clamd = await fakeClamd(() => reply as string);
      closer = clamd.close;
      await expect(new ClamAvScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 5000 }).scan(Readable.from([Buffer.from('x')])), reply).rejects.toBeInstanceOf(ScannerUnavailableError);
      closer();
    }
  });

  it('fails closed when nothing is listening', async () => {
    await expect(new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 }).scan(Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it('fails closed on a timeout', async () => {
    const clamd = await fakeClamd(() => 'hang');
    closer = clamd.close;
    await expect(new ClamAvScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 300 }).scan(Readable.from([Buffer.from('x')]))).rejects.toThrow(/timed out/);
  });

  it('fails closed when the source stream breaks', async () => {
    const clamd = await fakeClamd(() => 'stream: OK');
    closer = clamd.close;
    const bad = new Readable({ read() { this.destroy(new Error('disk error')); } });
    await expect(new ClamAvScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 2000 }).scan(bad)).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it('the disabled scanner (development only) says clean and drains the stream', async () => {
    expect(await new DisabledScanner().scan(Readable.from([Buffer.from('x')]))).toEqual({ clean: true });
  });
});
