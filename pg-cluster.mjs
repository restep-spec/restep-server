// Temporary PostgreSQL cluster for the pg.test.mjs tests. It never uses an existing database:
// initdb in a temporary directory, only a Unix socket in that directory (no TCP), a port between
// 54320 and 54329 (it only names the socket) and, when finished, pg_ctl stop and deleting the directory.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const BINARIES = ['initdb', 'pg_ctl', 'postgres'];

// Folder with initdb, pg_ctl and postgres: PG_BIN, pg_config --bindir, the PATH or usual locations.
export function findPgBin() {
  const has = (dir) => dir && BINARIES.every((b) => existsSync(join(dir, b)));
  if (process.env.PG_BIN) return has(process.env.PG_BIN) ? process.env.PG_BIN : null; // if set, only that one
  const candidates = [];
  const config = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (config.status === 0) candidates.push(config.stdout.trim());
  candidates.push(...(process.env.PATH ?? '').split(':'));
  candidates.push('/opt/homebrew/bin', '/usr/local/bin');
  for (const base of ['/usr/lib/postgresql', '/opt/homebrew/opt']) {
    try { for (const d of readdirSync(base).sort().reverse()) candidates.push(join(base, d, 'bin')); } catch {}
  }
  return candidates.find(has) ?? null;
}

// Reason to skip the suite, or null if it can run.
export function pgUnavailable() {
  if (!findPgBin()) return 'no PostgreSQL binaries (initdb, pg_ctl, postgres); set PG_BIN or install them';
  try { createRequire(import.meta.url).resolve('pg'); } catch { return 'the pg package is missing; run npm install in tools/restep-server'; }
  return null;
}

export async function startCluster({ ports = [54320, 54329] } = {}) {
  const bin = findPgBin();
  if (!bin) throw new Error('PostgreSQL not available');
  const dir = mkdtempSync(join(tmpdir(), 'restep-pg-'));
  const data = join(dir, 'data'), log = join(dir, 'log');
  const cleanup = () => {
    spawnSync(join(bin, 'pg_ctl'), ['-D', data, 'stop', '-m', 'immediate', '-w'], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  };
  process.once('exit', cleanup); // also if the test fails or throws
  const interrupted = (signal) => () => { cleanup(); process.exit(128 + (signal === 'SIGINT' ? 2 : 15)); };
  const handlers = ['SIGINT', 'SIGTERM'].map((s) => [s, interrupted(s)]);
  for (const [s, h] of handlers) process.once(s, h);
  const forget = () => { process.removeListener('exit', cleanup); for (const [s, h] of handlers) process.removeListener(s, h); };
  try {
    execFileSync(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C', '--no-sync'], { stdio: 'ignore' });
    let port;
    for (let p = ports[0]; p <= ports[1] && !port; p++) {
      if (existsSync(join(dir, `.s.PGSQL.${p}`))) continue;
      const r = spawnSync(join(bin, 'pg_ctl'), ['-D', data, '-l', log, '-w', '-t', '30', '-o', `-p ${p} -k ${dir} -c listen_addresses=''`, 'start'], { encoding: 'utf8' });
      if (r.status === 0) port = p;
    }
    if (!port) throw new Error(`could not start PostgreSQL on ${ports.join('-')}`);
    const ctl = (...args) => execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-l', log, '-w', '-t', '30', ...args], { stdio: 'ignore' });
    return {
      host: dir, port, dir,
      // Crash without a clean shutdown (like a power cut): on start, PostgreSQL recovers from the WAL.
      crash() { ctl('stop', '-m', 'immediate'); },
      start() { ctl('-o', `-p ${port} -k ${dir} -c listen_addresses=''`, 'start'); },
      stop() { forget(); cleanup(); },
    };
  } catch (e) {
    forget();
    cleanup();
    throw e;
  }
}
