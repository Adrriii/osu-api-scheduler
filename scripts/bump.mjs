#!/usr/bin/env node
/**
 * Bump the version across the workspace.
 *
 *   npm run bump              ask which part to raise
 *   npm run bump -- minor     raise that part
 *   npm run bump -- 2.0.0     set exactly this
 *
 * The dashboard footer needs nothing else: the server reads the root
 * package.json at runtime, so the footer shows whatever is written here as soon
 * as the service restarts. There is no second place to keep in step.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Every manifest carries the same version, so a bump is one number everywhere.
const MANIFESTS = ['package.json', 'server/package.json', 'web/package.json'];
const LEVELS = ['patch', 'minor', 'major'];

const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a plain x.y.z version: ${v}`);
  return m.slice(1, 4).map(Number);
}

function next(version, level) {
  const [major, minor, patch] = parse(version);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const current = read('package.json').version;
const arg = process.argv[2];

let target;
if (arg && LEVELS.includes(arg)) {
  target = next(current, arg);
} else if (arg) {
  // An explicit version, validated the same way so a typo cannot land.
  parse(arg);
  target = arg;
} else if (!process.stdin.isTTY) {
  console.error(`current version ${current}\nusage: npm run bump -- <${LEVELS.join('|')}|x.y.z>`);
  process.exit(2);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`current version ${current}\n`);
  LEVELS.forEach((l, i) => console.log(`  ${i + 1}) ${l.padEnd(5)} -> ${next(current, l)}`));
  const answer = (await rl.question('\nwhich? [1-3, or an explicit x.y.z] ')).trim();
  rl.close();

  const byNumber = LEVELS[Number(answer) - 1];
  const byName = LEVELS.includes(answer) ? answer : null;
  if (byNumber ?? byName) {
    target = next(current, byNumber ?? byName);
  } else if (answer) {
    parse(answer);
    target = answer;
  } else {
    console.error('nothing chosen');
    process.exit(1);
  }
}

if (target === current) {
  console.error(`already at ${current}`);
  process.exit(1);
}

for (const rel of MANIFESTS) {
  const path = join(ROOT, rel);
  const raw = readFileSync(path, 'utf8');
  // Rewrite the one line rather than reserialising: JSON.stringify would drop
  // the file's own formatting and turn a version bump into a whole-file diff.
  const out = raw.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${target}$2`);
  if (out === raw) throw new Error(`no version field rewritten in ${rel}`);
  writeFileSync(path, out);
}

// The lockfile records each workspace's version too, so leave it consistent.
execFileSync('npm', ['install', '--package-lock-only', '--silent'], { cwd: ROOT, stdio: 'inherit' });

console.log(`\n${current} -> ${target}`);
console.log(`updated: ${MANIFESTS.join(', ')}, package-lock.json`);
console.log('the dashboard footer picks this up when the service restarts');
