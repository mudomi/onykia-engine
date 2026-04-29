# Contributing

Thank you for considering to help out!

## Flow

0. Discuss a feature or issue in an Github issue before creating a pull-request.
1. Fork this repo.
2. Create a branch in your fork.
3. Open a PR to `develop`.
   - Reference the [GitHub issue](https://github.com/mudomi/onykia-engine/issues) you are trying to solve.
4. Address review feedback.
5. Maintainers merge to `develop`, then merge to `release` for release.

## Branches and environments

- `develop` = test channel
- `release` = stable release channel

## Change Promotion

PRs into `develop` are merged as **squash commits**.

That squash commit title must follow [Conventional Commits](https://www.conventionalcommits.org/) format.

When it's release time, maintainers promote `develop` to `release`.

## Versioning and builds

**Dev builds:**
- Automatically built and published to npm with a `dev` tag on every commit to `develop`.

**Release:**

1. Maintainer fast-forwards `develop` --> `release`.
2. automatic tags `vX.Y.Z` and GitHub Release with auto-generated notes.

The packages `@mudomi/onykia-engine`, `@mudomi/onykia-codemirror`, `@mudomi/onykia-monaco` share one version.

## PR expectations

- Keep PRs focused (one issue per PR).
- Make sure CI is green.
- Add context in the PR description: what changed, why, and how to test.
- Be responsive in review, and keep it friendly.
