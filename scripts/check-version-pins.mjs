import { readFileSync, readdirSync } from "node:fs";

const dependency = "@aetherpush/cli";
const templatesDirectory = "examples/ci";
const expectedTemplates = ["Jenkinsfile", "bitrise.yml", "circleci-config.yml", "gitlab-ci.yml"];
const config = JSON.parse(readFileSync("release-please-config.json", "utf8"));
const extraFiles = config.packages?.["."]?.["extra-files"] ?? [];
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

const configuredPaths = extraFiles
  .filter((entry) => entry?.type === "generic" && typeof entry.path === "string")
  .map((entry) => entry.path)
  .sort();

for (const name of expectedTemplates) {
  const path = `${templatesDirectory}/${name}`;
  if (!configuredPaths.includes(path)) {
    errors.push(`${path}: release-please does not manage the pin`);
  }
}

for (const path of configuredPaths) {
  if (!expectedTemplates.map((name) => `${templatesDirectory}/${name}`).includes(path)) {
    errors.push(`${path}: release-please manages an unregistered template`);
  }
}

for (const name of templates) {
  const path = `${templatesDirectory}/${name}`;
  if (!expectedTemplates.includes(name)) {
    errors.push(`${path}: template is not registered in the pin check`);
    continue;
  }

  const content = readFileSync(path, "utf8");
  const matches = content
    .split("\n")
    .filter((line) => line.includes("x-release-please-version"))
    .map((line) => line.match(/\d+\.\d+\.\d+/)?.[0])
    .filter((version) => version !== undefined);

  if (matches.length !== 1) {
    errors.push(`${path}: expected one release-please-managed ${dependency} pin, found ${matches.length}`);
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
  console.error("template pin check: CI templates drifted from release-please configuration");
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(`template pin check: ${pins.size} templates pin ${dependency} ${[...versions][0]}`);
