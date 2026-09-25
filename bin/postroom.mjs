#!/usr/bin/env node
// One image, one entrypoint per daemon (PST-ADR-001, PST-REQ-004): `postroom <daemon>` runs that
// daemon's built main; `postroom migrate` applies Prisma migrations; `postroom seed` seeds.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAEMONS = ['smtp-in', 'submission', 'imap', 'delivery', 'dav', 'api', 'worker', 'edge'];
const [command, ...rest] = process.argv.slice(2);

function run(cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, stdio: 'inherit', env: process.env });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
}

if (command !== undefined && DAEMONS.includes(command)) {
  const main = join(root, 'apps', command, 'dist', 'main.js');
  if (!existsSync(main)) {
    console.error(`postroom: ${command} is not built into this image (${main} is missing)`);
    process.exit(1);
  }
  await import(main);
} else if (command === 'migrate') {
  run(join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], join(root, 'packages', 'db'));
} else if (command === 'seed') {
  const seed = join(root, 'packages', 'db', 'dist', 'seed.js');
  run(process.execPath, [seed, ...rest], root);
} else {
  console.error(`usage: postroom <${DAEMONS.join('|')}|migrate|seed>`);
  process.exit(command === undefined ? 1 : 2);
}
