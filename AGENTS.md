# Galinum product monorepo

This repository owns the reusable Galinum product.

## Product rules

- Agents operate through the public management API and the distributable skill.
- The dashboard supervises campaigns. It does not author campaigns.
- Keep one generic campaign and channel model across cloud and self-hosted deployments.
- Product behavior and safety guarantees must be implemented and tested from
  this repository alone. Consumer-specific checks do not replace missing
  product safeguards.
- Public explanations and review replies must cite publicly accessible source
  and runnable tests. Keep repository guidance self-contained.

## Repository map

- `apps/docs` owns customer documentation, OpenAPI, MCP metadata, and the distributable skill.
- `packages/contracts` owns generated, mobile-safe installation wire types and schemas.
- `packages/core` owns product-only rules and adapter contracts.
- `packages/push` owns server-only push delivery, providers, and host contracts.
- `packages/server` owns the self-host API, local runtime adapters, and product schema.
- `packages/dashboard` owns reusable dashboard primitives and generic semantic tokens.
- `packages/react-native` owns the native installation client and Expo/bare adapters.
- `packages/react` owns the React SDK source, tests, and its packed tarball contents.
- `examples/react-native-expo` owns the disposable native client example.
- `examples/self-host` owns the local deployment example.
- `examples/react-nextjs` owns the React SDK example application.
- `release/packages.json` lists the release-owned packages and their paths.

## Commands

- Run `pnpm verify` for the complete local gate.
- Run `pnpm verify:affected -- --base <commit>` for the CI path filter.
- Run `pnpm release --output <directory>` to write release tarballs and `release-manifest.json` from a clean worktree.

Use Node 24 and the pnpm version in `package.json`.

## Delivery

External contributors use pull requests. Repository maintainers may push
release work directly to `main`.
