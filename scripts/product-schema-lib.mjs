export function productTableNames(dbTypes) {
  const match = /export interface ProductDB \{([\s\S]*?)\n\}/.exec(dbTypes);
  if (!match) throw new Error("ProductDB interface is missing");
  return [...match[1].matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((entry) => entry[1]).sort();
}

export function compareSchemaTables(actual, expected) {
  const failures = [];
  const duplicates = actual.filter((table, index) => actual.indexOf(table) !== index);
  const missing = expected.filter((table) => !actual.includes(table));
  const extra = actual.filter((table) => !expected.includes(table));
  if (duplicates.length) failures.push(`schema.sql declares ${[...new Set(duplicates)].join(", ")} more than once`);
  if (missing.length) failures.push(`schema.sql is missing ${missing.join(", ")}`);
  if (extra.length) failures.push(`schema.sql adds ${extra.join(", ")} outside ProductDB`);
  return failures;
}
