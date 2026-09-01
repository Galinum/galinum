# Release policy

Galinum releases the product from a clean `main` commit after CI passes.

## Release contents

One release manifest binds:

- The source commit and tree.
- The OpenAPI digest.
- Exact package tarballs for `@galinum/core`, `@galinum/dashboard`,
  `@galinum/react`, and `@galinum/server`.
- The two distributable skill files and their aggregate digest.

The packages and the skill use one version. The release tool builds each
package twice and rejects different outputs.

## Create a release

Run the complete gate:

```bash
pnpm verify
```

Write artifacts outside the repository:

```bash
pnpm release --output /absolute/path/to/release
```

Do not reuse a version for different bytes.

## Publication boundaries

A source release does not publish npm packages or containers. Publishing a
package or container is a separate release decision.

## Verify a consumable clone

Clone the repository, then run `pnpm verify:clean-clone`. It installs from
the public npm registry with no registry credentials, runs the full gate, and
starts the server without application secrets.
