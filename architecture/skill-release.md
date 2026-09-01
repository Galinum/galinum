# Skill release boundary

The product release owns the distributable skill as two immutable Markdown
files. The release manifest records the release version, each file digest, and
one aggregate skill digest.

The release keeps the files flat:

- `galinum-skill-<version>.md` contains `SKILL.md`.
- `galinum-skill-api-<version>.md` contains `references/api.md`.

A tar archive would add extraction and path validation for two files. Flat
files let a consumer verify each digest before any transform.

A managed host imports the files with the package artifacts. It may apply one
framework-specific frontmatter transform after verifying the source bytes.
The consumer manifest records the product commit, the release version, the
aggregate skill digest, and the transformed file digests.

No build, check, or deployment reads a sibling checkout or downloads mutable
documentation. The release manifest is the only cross-repository contract.
