#!/usr/bin/env node
// Stand-in for the env0 CLI in tests. Behavior is chosen by FAKE_ENV0_MODE.
const mode = process.env.FAKE_ENV0_MODE ?? 'ok';
if (mode === 'ok') {
  process.stdout.write(JSON.stringify({ apiVersion: '0.1', data: { args: process.argv.slice(2) } }));
  process.exit(0);
}
if (mode === 'auth') {
  process.stderr.write(JSON.stringify({ apiVersion: '0.1', error: { type: 'auth', message: 'missing credentials', host: 'https://api.example.com' } }));
  process.exit(3);
}
if (mode === 'garbage') {
  process.stdout.write('not json');
  process.exit(0);
}
process.stderr.write('plain failure text');
process.exit(1);
