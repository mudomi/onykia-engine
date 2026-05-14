export default {
  branches: ['release'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    [
      '@semantic-release/exec',
      {
        prepareCmd: 'node scripts/sync-version.mjs ${nextRelease.version}',
        publishCmd: [
          '"$SYSTEM_NPM" publish --workspace ./packages/engine     --access public --provenance --tag latest --loglevel verbose',
          '"$SYSTEM_NPM" publish --workspace ./packages/codemirror --access public --provenance --tag latest --loglevel verbose',
          '"$SYSTEM_NPM" publish --workspace ./packages/monaco     --access public --provenance --tag latest --loglevel verbose',
        ].join(' && '),
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: [
          'CHANGELOG.md',
          'package.json',
          'package-lock.json',
          'packages/*/package.json',
        ],
        message: 'chore(release): ${nextRelease.version}\n\n${nextRelease.notes}',
      },
    ],
    '@semantic-release/github',
  ],
};
