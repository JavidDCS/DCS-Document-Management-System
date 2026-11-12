import net from 'node:net';
import type { Readable } from 'node:stream';

export type ScanVerdict = { clean: true } | { clean: false; signature: string };

/** Anything that can say whether a file stream is malware. ClamAV in production; a fake in tests. */
export interface MalwareScanner {
  readonly name: string;
  scan(data: Readable): Promise<ScanVerdict>;
}

export class ScannerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScannerUnavailableError';
  }
}

export interface ClamAvOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** clamd's StreamMaxLength is usually 25 MB; larger files are refused by the daemon, so we fail closed. */
  chunkSize?: number;
}

/**
 * Minimal clamd client speaking the INSTREAM protocol: "zINSTREAM\0", then length-prefixed chunks (4-byte big-endian),
 * then a zero-length chunk; the reply is "stream: OK", "stream: <signature> FOUND" or "... ERROR".
 * Any problem (connection, timeout, ERROR reply) is "scanner unavailable": the caller must not treat the file as clean.
 */
export class ClamAvScanner implements MalwareScanner {
  readonly name = 'clamav';

  constructor(private readonly opts: ClamAvOptions) {}

  scan(data: Readable): Promise<ScanVerdict> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
      let reply = '';
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        data.destroy();
        fn();
      };
      const timer = setTimeout(() => done(() => reject(new ScannerUnavailableError('ClamAV timed out'))), this.opts.timeoutMs);

      socket.once('error', (err) => done(() => reject(new ScannerUnavailableError('Cannot talk to ClamAV', { cause: err }))));
      socket.on('data', (d) => {
        reply += d.toString('utf8');
      });
      socket.once('close', () => {
        done(() => {
          const text = reply.replace(/\0/g, '').trim();
          const found = /^stream:\s*(.+?)\s+FOUND$/i.exec(text);
          if (found) return resolve({ clean: false, signature: found[1]!.slice(0, 200) });
          if (/^stream:\s*OK$/i.test(text)) return resolve({ clean: true });
          reject(new ScannerUnavailableError(`Unexpected ClamAV reply: ${text.slice(0, 100) || '(empty)'}`));
        });
      });

      socket.once('connect', () => {
        socket.write('zINSTREAM\0');
        const send = async () => {
          try {
            for await (const chunk of data) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
              for (let i = 0; i < buf.length; i += this.opts.chunkSize ?? 64 * 1024) {
                const part = buf.subarray(i, i + (this.opts.chunkSize ?? 64 * 1024));
                const len = Buffer.alloc(4);
                len.writeUInt32BE(part.length, 0);
                if (!socket.write(Buffer.concat([len, part]))) await new Promise<void>((r) => socket.once('drain', r));
              }
            }
            socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
          } catch (err) {
            done(() => reject(new ScannerUnavailableError('Could not stream the file to ClamAV', { cause: err })));
          }
        };
        void send();
      });
    });
  }
}

/** Used only when MALWARE_SCAN_ENABLED=false (development). Refused in production by the env schema. */
export class DisabledScanner implements MalwareScanner {
  readonly name = 'disabled';
  async scan(data: Readable): Promise<ScanVerdict> {
    data.resume();
    return { clean: true };
  }
}
