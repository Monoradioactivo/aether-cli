import * as fs from "fs";
import * as chalk from "chalk";
import * as path from "path";
import * as childProcess from "child_process";
import { coerce, compare, valid } from "semver";
import { fileDoesNotExistOrIsDirectory } from "./utils/file-utils";

const g2js = require("gradle-to-js/lib/parser");
const properties = require("properties");

export interface HermesDetection {
  enabled: boolean;
  reason: string;
}

export class HermesCompilerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesCompilerUnavailableError";
  }
}

export function isValidVersion(version: string): boolean {
  return !!valid(version) || /^\d+\.\d+$/.test(version);
}

export async function runHermesEmitBinaryCommand(
  bundleName: string,
  outputFolder: string,
  sourcemapOutput: string,
  extraHermesFlags: string[],
  gradleFile: string,
  json: boolean = false
): Promise<void> {
  const suppressWarnings = extraHermesFlags.indexOf("-w") === -1 ? ["-w"] : [];
  const hermesArgs: string[] = [
    ...suppressWarnings,
    "-emit-binary",
    "-out",
    path.join(outputFolder, bundleName + ".hbc"),
    path.join(outputFolder, bundleName),
    ...extraHermesFlags,
  ];

  if (sourcemapOutput) {
    hermesArgs.push("-output-source-map");
  }

  const progress = (message: string): void => {
    if (json) {
      console.error(message);
    } else {
      console.log(message);
    }
  };

  progress(chalk.cyan("Converting JS bundle to byte code via Hermes, running command:\n"));
  const hermesCommand = await getHermesCommand(gradleFile);
  const compilerUnavailable = (error: NodeJS.ErrnoException): HermesCompilerUnavailableError =>
    new HermesCompilerUnavailableError(`Unable to run the Hermes compiler at ${hermesCommand} (${error.code || error.message}).`);
  let hermesProcess: childProcess.ChildProcess;
  try {
    hermesProcess = childProcess.spawn(hermesCommand, hermesArgs);
  } catch (error) {
    throw compilerUnavailable(error);
  }
  progress(`${hermesCommand} ${hermesArgs.join(" ")}`);

  return new Promise<void>((resolve, reject) => {
    let spawnFailed = false;

    hermesProcess.on("error", (error: NodeJS.ErrnoException) => {
      spawnFailed = true;
      reject(compilerUnavailable(error));
    });

    hermesProcess.stdout.on("data", (data: Buffer) => {
      progress(data.toString().trim());
    });

    hermesProcess.stderr.on("data", (data: Buffer) => {
      console.error(data.toString().trim());
    });

    hermesProcess.on("close", (exitCode: number, signal: string) => {
      if (spawnFailed) {
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(`"hermes" command failed (exitCode=${exitCode}, signal=${signal}).`));
        return;
      }
      const source = path.join(outputFolder, bundleName + ".hbc");
      const destination = path.join(outputFolder, bundleName);
      fs.copyFile(source, destination, (err) => {
        if (err) {
          console.error(err);
          reject(new Error(`Copying file ${source} to ${destination} failed. "hermes" previously exited with code ${exitCode}.`));
          return;
        }
        fs.unlink(source, (err) => {
          if (err) {
            console.error(err);
            reject(err);
            return;
          }
          resolve();
        });
      });
    });
  }).then(() => {
    if (!sourcemapOutput) {
      return;
    }

    const composeSourceMapsPath = getComposeSourceMapsPath();
    if (!composeSourceMapsPath) {
      throw new Error("react-native compose-source-maps.js scripts is not found");
    }

    const jsCompilerSourceMapFile = path.join(outputFolder, bundleName + ".hbc" + ".map");
    if (!fs.existsSync(jsCompilerSourceMapFile)) {
      throw new Error(`sourcemap file ${jsCompilerSourceMapFile} is not found`);
    }

    return new Promise((resolve, reject) => {
      const composeSourceMapsArgs = [composeSourceMapsPath, sourcemapOutput, jsCompilerSourceMapFile, "-o", sourcemapOutput];
      const composeSourceMapsProcess = childProcess.spawn("node", composeSourceMapsArgs);
      progress(`${composeSourceMapsPath} ${composeSourceMapsArgs.join(" ")}`);

      composeSourceMapsProcess.stdout.on("data", (data: Buffer) => {
        progress(data.toString().trim());
      });

      composeSourceMapsProcess.stderr.on("data", (data: Buffer) => {
        console.error(data.toString().trim());
      });

      composeSourceMapsProcess.on("close", (exitCode: number, signal: string) => {
        if (exitCode !== 0) {
          reject(new Error(`"compose-source-maps" command failed (exitCode=${exitCode}, signal=${signal}).`));
          return;
        }
        fs.unlink(jsCompilerSourceMapFile, (err) => {
          if (err) {
            console.error(err);
            reject(err);
            return;
          }
          resolve(undefined);
        });
      });
    });
  });
}

function resolveBuildGradlePath(gradleFile: string): string {
  let buildGradlePath: string = gradleFile || path.join("android", "app");
  let isDir = false;
  try {
    isDir = fs.lstatSync(buildGradlePath).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    buildGradlePath = path.join(buildGradlePath, "build.gradle");
  }
  if (fileDoesNotExistOrIsDirectory(buildGradlePath)) {
    throw new Error(`Unable to find gradle file "${buildGradlePath}".`);
  }
  return buildGradlePath;
}

async function parseBuildGradleFile(buildGradlePath: string): Promise<any> {
  try {
    return await g2js.parseFile(buildGradlePath);
  } catch {
    throw new Error(`Unable to parse the "${buildGradlePath}" file. Please ensure it is a well-formed Gradle file.`);
  }
}

async function getHermesCommandFromGradle(gradleFile: string): Promise<string> {
  let buildGradle: any;
  try {
    buildGradle = await parseBuildGradleFile(resolveBuildGradlePath(gradleFile));
  } catch {
    return "";
  }
  const hermesCommandProperty: any = Array.from(buildGradle["project.ext.react"] || []).find((prop: string) =>
    prop.trim().startsWith("hermesCommand:")
  );
  if (hermesCommandProperty) {
    return hermesCommandProperty.replace("hermesCommand:", "").trim().slice(1, -1);
  } else {
    return "";
  }
}

interface GradlePropertiesFile {
  file: string;
  values: Record<string, unknown>;
}

interface GradleProperty {
  file: string;
  key: string;
  value: string;
}

function displayPath(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

const BYTE_ORDER_MARK = 0xfeff;

function readGradlePropertiesFile(directory: string): GradlePropertiesFile | null {
  const file = path.join(directory, "gradle.properties");
  if (fileDoesNotExistOrIsDirectory(file)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const contents = raw.charCodeAt(0) === BYTE_ORDER_MARK ? raw.slice(1) : raw;
    return { file, values: properties.parse(contents) || {} };
  } catch {
    throw new Error(`Unable to parse "${displayPath(file)}". Please ensure it is a well-formed properties file.`);
  }
}

function findGradleProperty(files: GradlePropertiesFile[], key: string): GradleProperty | null {
  const owner = files.find((candidate) => Object.prototype.hasOwnProperty.call(candidate.values, key));
  if (!owner) {
    return null;
  }
  const value = owner.values[key];
  return { file: owner.file, key, value: value === null || value === undefined ? "" : String(value).trim() };
}

function declaresVariantScopedHermes(buildGradlePath: string): boolean {
  return /^[ \t]*enableHermesOnlyInVariants\b/m.test(fs.readFileSync(buildGradlePath, "utf8"));
}

export async function getAndroidHermesEnabled(gradleFile: string): Promise<HermesDetection> {
  const buildGradlePath = resolveBuildGradlePath(gradleFile);
  const appDirectory = path.dirname(buildGradlePath);
  const propertyFiles = [appDirectory, path.dirname(appDirectory)]
    .map(readGradlePropertiesFile)
    .filter((candidate): candidate is GradlePropertiesFile => candidate !== null);
  const hermesProperty = findGradleProperty(propertyFiles, "hermesEnabled") || findGradleProperty(propertyFiles, "react.hermesEnabled");

  if (hermesProperty) {
    const setting = `${hermesProperty.key}=${hermesProperty.value} in ${displayPath(hermesProperty.file)}`;
    if (hermesProperty.value.toLowerCase() === "false") {
      return { enabled: false, reason: `Hermes is off for this project: ${setting}.` };
    }
    if (declaresVariantScopedHermes(buildGradlePath)) {
      return {
        enabled: false,
        reason: `Hermes compilation skipped: enableHermesOnlyInVariants in ${displayPath(buildGradlePath)} limits Hermes to some build variants. Pass --useHermes when the targeted binary uses Hermes.`,
      };
    }
    return { enabled: true, reason: `Hermes is on for this project: ${setting}.` };
  }

  const buildGradle: any = await parseBuildGradleFile(buildGradlePath);
  const legacyMarker = Array.from(buildGradle["project.ext.react"] || []).some((line: string) =>
    /^enableHermes\s{0,}:\s{0,}true/.test(line)
  );
  if (legacyMarker) {
    return { enabled: true, reason: `Hermes is on for this project: enableHermes: true in ${displayPath(buildGradlePath)}.` };
  }
  return {
    enabled: false,
    reason: `Hermes not detected: no hermesEnabled in gradle.properties and no enableHermes: true in ${displayPath(buildGradlePath)}.`,
  };
}

const PODFILE_HERMES_ENABLED = /^[^#\n]*:?hermes_enabled(\s+|\n+)?(=>|:)(\s+|\n+)?true/m;
const PODFILE_LOCK_HERMES_ENGINE_POD = /^\s*-\s+"?hermes-engine(\/[^\s"]+)?\s+\(/m;
const PODFILE_LOCK_THIRD_PARTY_JSC_POD = /^\s*-\s+"?React-jsc(\/[^\s"]+)?\s+\(/m;

export function getiOSHermesEnabled(podFile: string): HermesDetection {
  const podPath = podFile || path.join("ios", "Podfile");
  if (fileDoesNotExistOrIsDirectory(podPath)) {
    throw new Error(`Unable to find Podfile file "${podPath}".`);
  }

  const podFileContents = fs.readFileSync(podPath).toString();
  const lockPath = path.join(path.dirname(podPath), "Podfile.lock");
  const lockContents = fileDoesNotExistOrIsDirectory(lockPath) ? null : fs.readFileSync(lockPath).toString();

  if (lockContents !== null && PODFILE_LOCK_THIRD_PARTY_JSC_POD.test(lockContents)) {
    return { enabled: false, reason: `Hermes is off for this project: ${displayPath(lockPath)} lists the React-jsc pod.` };
  }
  if (PODFILE_HERMES_ENABLED.test(podFileContents)) {
    return { enabled: true, reason: `Hermes is on for this project: hermes_enabled => true in ${displayPath(podPath)}.` };
  }
  if (lockContents !== null && PODFILE_LOCK_HERMES_ENGINE_POD.test(lockContents)) {
    return { enabled: true, reason: `Hermes is on for this project: ${displayPath(lockPath)} lists the hermes-engine pod.` };
  }
  return {
    enabled: false,
    reason:
      lockContents === null
        ? `Hermes not detected: no Podfile.lock next to ${displayPath(podPath)} and no hermes_enabled => true in it.`
        : `Hermes not detected: ${displayPath(lockPath)} lists no hermes-engine pod.`,
  };
}

function getHermesOSBin(): string {
  switch (process.platform) {
    case "win32":
      return "win64-bin";
    case "darwin":
      return "osx-bin";
    case "freebsd":
    case "linux":
    case "sunos":
    default:
      return "linux64-bin";
  }
}

function getInstalledReactNativeVersion(reactNativePackagePath: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(reactNativePackagePath, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

function getHermesOSExe(reactNativePackagePath: string): string {
  let declaredVersion: string = null;
  try {
    declaredVersion = getReactNativeVersion();
  } catch {
    declaredVersion = null;
  }
  const version = coerce(getInstalledReactNativeVersion(reactNativePackagePath)) || coerce(declaredVersion);
  const hermesExecutableName = !version || compare(version.version, "0.63.0") !== -1 ? "hermesc" : "hermes";
  switch (process.platform) {
    case "win32":
      return hermesExecutableName + ".exe";
    default:
      return hermesExecutableName;
  }
}

function reactNativeDependsOnHermesCompiler(reactNativePackagePath: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(reactNativePackagePath, "package.json"), "utf8"));
    return Boolean(manifest.dependencies && manifest.dependencies["hermes-compiler"]);
  } catch {
    return false;
  }
}

function resolveHermesCompilerPackageDirectory(reactNativePackagePath: string): string | null {
  try {
    return path.dirname(require.resolve("hermes-compiler/package.json", { paths: [reactNativePackagePath] }));
  } catch {
    return null;
  }
}

function hermesCompilerPackageCandidates(reactNativePackagePath: string, osBin: string, osExe: string): string[] {
  if (!reactNativeDependsOnHermesCompiler(reactNativePackagePath)) {
    return [];
  }
  const candidates: string[] = [];
  const reactNativeHermesCompilerDirectory = resolveHermesCompilerPackageDirectory(reactNativePackagePath);
  if (reactNativeHermesCompilerDirectory) {
    candidates.push(path.join(reactNativeHermesCompilerDirectory, "hermesc", osBin, osExe));
  }
  candidates.push(path.join(process.cwd(), "node_modules", "hermes-compiler", "hermesc", osBin, osExe));
  return candidates;
}

async function getHermesCommand(gradleFile: string): Promise<string> {
  const fileExists = (file: string): boolean => {
    try {
      return fs.statSync(file).isFile();
    } catch (_e) {
      return false;
    }
  };
  const reactNativePackagePath = getReactNativePackagePath();
  const osBin = getHermesOSBin();
  const osExe = getHermesOSExe(reactNativePackagePath);
  const triedLocations: string[] = [];
  const firstExisting = (...candidates: string[]): string | null => {
    for (const candidate of candidates) {
      if (triedLocations.indexOf(candidate) === -1) {
        triedLocations.push(candidate);
      }
      if (fileExists(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  const compilerPackageBinary = firstExisting(...hermesCompilerPackageCandidates(reactNativePackagePath, osBin, osExe));
  if (compilerPackageBinary) {
    return compilerPackageBinary;
  }

  const bundledHermesEngine = firstExisting(path.join(reactNativePackagePath, "sdks", "hermesc", osBin, osExe));
  if (bundledHermesEngine) {
    return bundledHermesEngine;
  }

  const gradleHermesCommand = await getHermesCommandFromGradle(gradleFile);
  if (gradleHermesCommand) {
    return path.join("android", "app", gradleHermesCommand.replace("%OS-BIN%", osBin));
  }

  const legacyBinary = firstExisting(
    path.join(process.cwd(), "node_modules", "hermes-engine", osBin, osExe),
    path.join(process.cwd(), "node_modules", "hermesvm", osBin, "hermes")
  );
  if (legacyBinary) {
    return legacyBinary;
  }

  throw new HermesCompilerUnavailableError(
    "Unable to find the Hermes compiler. Tried the following locations:\n" + triedLocations.map((location) => `  ${location}`).join("\n")
  );
}

function getComposeSourceMapsPath(): string {
  const composeSourceMaps = path.join(getReactNativePackagePath(), "scripts", "compose-source-maps.js");
  if (fs.existsSync(composeSourceMaps)) {
    return composeSourceMaps;
  }
  return null;
}

function getReactNativePackagePath(): string {
  const result = childProcess.spawnSync("node", ["--print", "require.resolve('react-native/package.json')"]);
  const packagePath = path.dirname(result.stdout.toString());
  if (result.status === 0 && directoryExistsSync(packagePath)) {
    return packagePath;
  }

  return path.join("node_modules", "react-native");
}

export function directoryExistsSync(dirname: string): boolean {
  try {
    return fs.statSync(dirname).isDirectory();
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  return false;
}

export function getReactNativeVersion(): string {
  let packageJsonFilename;
  let projectPackageJson;
  try {
    packageJsonFilename = path.join(process.cwd(), "package.json");
    projectPackageJson = JSON.parse(fs.readFileSync(packageJsonFilename, "utf-8"));
  } catch (_error) {
    throw new Error(
      `Unable to find or read "package.json" in the CWD. The "release-react" command must be executed in a React Native project folder.`
    );
  }

  const projectName: string = projectPackageJson.name;
  if (!projectName) {
    throw new Error(`The "package.json" file in the CWD does not have the "name" field set.`);
  }

  return (
    (projectPackageJson.dependencies && projectPackageJson.dependencies["react-native"]) ||
    (projectPackageJson.devDependencies && projectPackageJson.devDependencies["react-native"])
  );
}
