// A TCP pass-through that can be severed on demand.
//
// Checklist A11 asks whether `subscribe` survives a network drop and resumes from cursor. The
// admin SDK has no disableNetwork(), so the honest options were to skip the box or to actually
// cut the wire. This cuts the wire: the Firestore client is pointed at this proxy instead of
// the emulator, and cut() destroys every live socket the way a closing laptop lid does.
//
// It also makes the ">30 minutes offline gets rebilled as a new query" concern testable,
// because the outage duration is ours to control.
//
// Test-only. Nothing here ships.

import net from 'node:net';

export interface TcpCutter {
  /** Host:port the client should connect to instead of the real backend. */
  address: string;
  port: number;
  /** Destroy all live sockets and refuse new connections until heal(). */
  cut(): void;
  /** Accept connections again. Existing clients reconnect on their own. */
  heal(): void;
  /** Number of client connections accepted since start. Proves a reconnect happened. */
  connections(): number;
  close(): Promise<void>;
}

export async function startTcpCutter(target: { host: string; port: number }): Promise<TcpCutter> {
  const live = new Set<net.Socket>();
  let severed = false;
  let accepted = 0;

  const server = net.createServer((client) => {
    accepted++;
    if (severed) {
      // Refusing during an outage is what makes the client back off and retry, rather than
      // sitting on a half-open socket that never delivers.
      client.destroy();
      return;
    }
    const upstream = net.connect(target.port, target.host);
    live.add(client);
    live.add(upstream);

    const drop = (s: net.Socket) => {
      live.delete(s);
      s.destroy();
    };
    client.on('error', () => drop(client));
    upstream.on('error', () => drop(client));
    client.on('close', () => drop(upstream));
    upstream.on('close', () => drop(client));
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('cutter failed to bind a port');

  return {
    address: `127.0.0.1:${addr.port}`,
    port: addr.port,
    cut() {
      severed = true;
      for (const s of [...live]) {
        live.delete(s);
        s.destroy();
      }
    },
    heal() {
      severed = false;
    },
    connections: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        severed = true;
        for (const s of [...live]) s.destroy();
        live.clear();
        server.close(() => resolve());
      }),
  };
}
