import { readFileSync, readdirSync } from "node:fs";

const dependency = "@aetherpush/cli";
const templatesDirectory = "examples/ci";
const expectedTemplates = ["Jenkinsfile", "bitrise.yml", "circleci-config.yml", "gitlab-ci.yml"];
const config = JSON.parse(readFileSync("renovate.json", "utf8"));
const managers = config.customManagers ?? [];
const templates = readdirSync(templatesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
  .map((entry) => entry.name)
  .sort();
const errors = [];
const pins = new Map();

for (const name of expectedTemplates) {
  if (!templates.includes(name)) {
    errors.push(`${templatesDirectory}/${name}: expected template is missing`);
  }
}

for (const name of templates) {
  const path = `${templatesDirectory}/${name}`;
  if (!expectedTemplates.includes(name)) {
    errors.push(`${path}: template is not registered in the pin check`);
    continue;
  }

  const coveringManagers = managers.filter(
    (manager) => manager.depNameTemplate === dependency && (manager.fileMatch ?? []).some((pattern) => new RegExp(pattern).test(path))
  );

  if (coveringManagers.length !== 1) {
    errors.push(`${path}: expected one Renovate manager for ${dependency}, found ${coveringManagers.length}`);
    continue;
  }

  const content = readFileSync(path, "utf8");
  const matches = [];
  for (const source of coveringManagers[0].matchStrings ?? []) {
    for (const match of content.matchAll(new RegExp(source, "g"))) {
      if (match.groups?.currentValue) {
        matches.push(match.groups.currentValue);
      }
    }
  }

  if (matches.length !== 1) {
    errors.push(`${path}: expected one managed ${dependency} pin, found ${matches.length}`);
    continue;
  }

  pins.set(path, matches[0]);
}

const versions = new Set(pins.values());
if (versions.size > 1) {
  const detail = [...pins.entries()].map(([path, version]) => `${version} (${path})`).join(", ");
  errors.push(`inconsistent pins for ${dependency}: ${detail}`);
}

if (errors.length > 0) {
  console.error("template pin check: CI templates drifted from renovate.json");
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(`template pin check: ${pins.size} templates pin ${dependency} ${[...versions][0]}`);
