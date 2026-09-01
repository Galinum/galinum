const allowedImports = [
  "react",
  "@galinum/core",
  "@base-ui/react/",
  "class-variance-authority",
  "clsx",
  "lucide-react",
  "tailwind-merge",
];
const providerImports = [
  "@ai-sdk/",
  "@better-auth/",
  "@react-email/",
  "@vercel/",
  "better-auth",
  "posthog-js",
  "posthog-node",
  "resend",
  "stripe",
];
const databaseImports = ["kysely", "pg", "postgres", "drizzle-orm"];

function importSpecifiers(contents) {
  const specifiers = [];
  const pattern = /(?:from\s+|import\s*\(|import\s+)["']([^"']+)["']/g;
  for (const match of contents.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

function matchesPrefix(specifier, values) {
  return values.some((value) => specifier === value || specifier.startsWith(value));
}

export function dashboardBoundaryFailures(name, contents, clientDirective) {
  const failures = [];
  if (/@\//.test(contents)) failures.push(name + " contains a cloud alias");
  if (/galinum-cloud|app\/(?:cloud|lib)\//.test(contents)) {
    failures.push(name + " contains a cloud source path");
  }
  if (/\bprocess\.env\b|\bimport\.meta\.env\b/.test(contents)) {
    failures.push(name + " reads the environment");
  }
  if (/\bDATABASE_(?:URL|ADMIN_URL)\b|\bcreatePool\b|\bPool\s*\(/.test(contents)) {
    failures.push(name + " accesses a database");
  }
  if (/^["']use server["'];?/m.test(contents)) {
    failures.push(name + " contains a server action directive");
  }
  if (clientDirective && !contents.startsWith('"use client"')) {
    failures.push(name + " is missing its client directive");
  }
  for (const specifier of importSpecifiers(contents)) {
    if (specifier.startsWith(".")) continue;
    if (matchesPrefix(specifier, providerImports)) {
      failures.push(name + " imports provider package " + specifier);
    } else if (matchesPrefix(specifier, databaseImports)) {
      failures.push(name + " imports database package " + specifier);
    } else if (!matchesPrefix(specifier, allowedImports)) {
      failures.push(name + " imports unsupported package " + specifier);
    }
  }
  return failures;
}

export function dashboardTokenFailures(contents) {
  const failures = [];
  if (/--(?:pill|glass|waitlist|field-pill|accent-light|sky|font-wordmark)/.test(contents)) {
    failures.push("dashboard tokens contain private marketing variables");
  }
  if (/\.(?:hero|grain|animate-|theme-)/.test(contents)) {
    failures.push("dashboard tokens contain private application styles");
  }
  return failures;
}
