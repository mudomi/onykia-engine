#!/usr/bin/env node
// Stamp one semver across every workspace package.json.
import { execSync } from 'node:child_process';

const version = process.argv[2];
if (!version) {
  console.error('usage: sync-version.mjs <version>');
  process.exit(1);
}

execSync(
  `npm version ${version} --no-git-tag-version --allow-same-version`,
  { stdio: 'inherit' },
);

const workspaces = [
  'packages/engine',
  'packages/codemirror',
  'packages/monaco',
];

for (const ws of workspaces) {
  execSync(
    `npm version ${version} --no-git-tag-version --workspace ./${ws} --allow-same-version`,
    { stdio: 'inherit' },
  );
}
