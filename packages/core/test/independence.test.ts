// The core contract: zero OpenMausBot (or any other harness) imports.
// This test reads every source file of the standalone packages and fails
// on any import that reaches outside the TeachReplay packages.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("standalone independence", () => {
  it("no package source imports anything outside @teachreplay", () => {
    const violations: string[] = [];
    for (const packageName of ["core", "remote", "mock"]) {
      for (const file of sourceFiles(join(PACKAGES_ROOT, packageName, "src"))) {
        const content = readFileSync(file, "utf8");
        for (const match of content.matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)) {
          const specifier = match[1] ?? match[2]!;
          if (specifier.startsWith("node:")) continue;
          if (specifier.startsWith(".")) continue;
          if (specifier.startsWith("@teachreplay/")) continue;
          violations.push(`${file}: imports "${specifier}"`);
        }
        for (const match of content.matchAll(/from\s+["'](\.\.\/){2,}[^"']+["']/g)) {
          violations.push(`${file}: escapes the package with "${match[0]}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no package source imports anything from the OpenMausBot harness", () => {
    const hits: string[] = [];
    for (const packageName of ["core", "remote", "mock"]) {
      for (const file of sourceFiles(join(PACKAGES_ROOT, packageName, "src"))) {
        const content = readFileSync(file, "utf8");
        for (const match of content.matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)) {
          const specifier = match[1] ?? match[2]!;
          if (/openmausbot|openmaus-bot/i.test(specifier)) hits.push(`${file}: "${specifier}"`);
          if (/server\/(contracts|index|store|box|config|redact|computer-observation|remote-computer)\.ts/.test(specifier)) {
            hits.push(`${file}: "${specifier}"`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
