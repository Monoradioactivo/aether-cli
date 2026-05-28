// Copyright (c) Aether. All rights reserved.

import AccountManager = require("./management-sdk");
const childProcess = require("child_process");
import debugCommand from "./commands/debug";
import * as fs from "fs";
import * as chalk from "chalk";
const g2js = require("gradle-to-js/lib/parser");
import * as moment from "moment";
import * as os from "os";
import * as path from "path";
const plist = require("plist");
const prompt = require("prompt");
const rimraf = require("rimraf");
import * as semver from "semver";
const Table = require("cli-table");
import wordwrap = require("wordwrap");
import * as cli from "../script/types/cli";
import sign from "./sign";
const xcode = require("xcode");
import { AetherError } from "./errors";
import {
  AccessKey,
  AccessKeyWithSecret,
  ApiKey,
  ApiKeyCreationRequest,
  ApiKeyScope,
  ApiKeyUpdateRequest,
  ApiKeyWithSecret,
  App,
  CollaboratorMap,
  CollaboratorProperties,
  Deployment,
  DeploymentMetrics,
  Package,
  PackageInfo,
  Session,
  UpdateMetrics,
} from "../script/types";
import { getAndroidHermesEnabled, getiOSHermesEnabled, runHermesEmitBinaryCommand, isValidVersion } from "./react-native-utils";
import { fileDoesNotExistOrIsDirectory, isBinaryOrZip, fileExists } from "./utils/file-utils";

const configFilePath: string = path.join(process.env.LOCALAPPDATA || process.env.HOME, ".aether", "config.json");
const DEFAULT_AETHER_SERVER_URL = "https://api-staging.aetherpush.com";
const emailValidator = require("email-validator");
const packageJson = require("../../package.json");
const properties = require("properties");

const CLI_HEADERS: Record<string, string> = {
  "X-Aether-CLI-Version": packageJson.version,
};

/** Deprecated */
interface ILegacyLoginConnectionInfo {
  accessKeyName: string;
}

interface ILoginConnectionInfo {
  accessKey: string;
  customServerUrl?: string; // A custom serverUrl for internal debugging purposes
  preserveAccessKeyOnLogout?: boolean;
}

export interface UpdateMetricsWithTotalActive extends UpdateMetrics {
  totalActive: number;
}

export interface PackageWithMetrics {
  metrics?: UpdateMetricsWithTotalActive;
}

export const log = (message: string | any): void => console.log(message);
export let sdk: AccountManager;
export const spawn = childProcess.spawn;
export const execSync = childProcess.execSync;

let connectionInfo: ILoginConnectionInfo;

export const confirm = (message: string = "Are you sure?", autoConfirm: boolean = false): Promise<boolean> => {
  if (autoConfirm) {
    return Promise.resolve(true);
  }

  message += " (y/N):";
  return new Promise<boolean>((resolve, reject): void => {
    prompt.message = "";
    prompt.delimiter = "";

    prompt.start();

    prompt.get(
      {
        properties: {
          response: {
            description: chalk.cyan(message),
          },
        },
      },
      (err: any, result: any): void => {
        const accepted = result.response && result.response.toLowerCase() === "y";
        const rejected = !result.response || result.response.toLowerCase() === "n";

        if (accepted) {
          resolve(true);
        } else {
          if (!rejected) {
            console.log('Invalid response: "' + result.response + '"');
          }
          resolve(false);
        }
      }
    );
  });
};

function resolveNonInteractive(command: cli.ICommand): boolean {
  if (command.nonInteractive !== undefined) {
    return command.nonInteractive;
  }

  if (process.env.CI === "true") {
    console.error("[Aether] Detected CI environment — running in non-interactive mode.");
    return true;
  }

  return false;
}

function confirmDestructive(command: cli.ICommand, message?: string): Promise<boolean> {
  if (command.force) {
    return Promise.resolve(true);
  }

  if (command.nonInteractive) {
    return Promise.reject(new Error("This is a destructive action. Re-run with --force to confirm in non-interactive mode."));
  }

  return confirm(message);
}

function accessKeyAdd(command: cli.IAccessKeyAddCommand): Promise<void> {
  return sdk.addAccessKey(command.name, command.ttl).then((accessKey: AccessKeyWithSecret) => {
    log(`Successfully created the "${command.name}" access key: ${accessKey.name}`);
    log("Make sure to save this key value somewhere safe, since you won't be able to view it from the CLI again!");
  });
}

function accessKeyPatch(command: cli.IAccessKeyPatchCommand): Promise<void> {
  const willUpdateName: boolean = isCommandOptionSpecified(command.newName) && command.oldName !== command.newName;
  const willUpdateTtl: boolean = isCommandOptionSpecified(command.ttl);

  if (!willUpdateName && !willUpdateTtl) {
    throw new Error("A new name and/or TTL must be provided.");
  }

  return sdk.patchAccessKey(command.oldName, command.newName, command.ttl).then((accessKey: AccessKey) => {
    let logMessage: string = "Successfully ";
    if (willUpdateName) {
      logMessage += `renamed the access key "${command.oldName}" to "${command.newName}"`;
    }

    if (willUpdateTtl) {
      const expirationDate = moment(accessKey.expires).format("LLLL");
      if (willUpdateName) {
        logMessage += ` and changed its expiration date to ${expirationDate}`;
      } else {
        logMessage += `changed the expiration date of the "${command.oldName}" access key to ${expirationDate}`;
      }
    }

    log(`${logMessage}.`);
  });
}

function accessKeyList(command: cli.IAccessKeyListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return sdk.getAccessKeys().then((accessKeys: AccessKey[]): void => {
    printAccessKeys(command.format, accessKeys);
  });
}

function accessKeyRemove(command: cli.IAccessKeyRemoveCommand): Promise<void> {
  return confirmDestructive(command).then((wasConfirmed: boolean) => {
    if (wasConfirmed) {
      return sdk.removeAccessKey(command.accessKey).then((): void => {
        log(`Successfully removed the "${command.accessKey}" access key.`);
      });
    }

    log("Access key removal cancelled.");
  });
}

const VALID_API_KEY_SCOPES: ApiKeyScope[] = ["deploy", "apps", "keys", "read"];

function validateApiKeyScopes(scopes: string[]): ApiKeyScope[] {
  if (!scopes || scopes.length === 0) {
    throw new Error(`At least one scope must be provided. Valid scopes: ${VALID_API_KEY_SCOPES.join(", ")}.`);
  }
  for (const s of scopes) {
    if (!VALID_API_KEY_SCOPES.includes(s as ApiKeyScope)) {
      throw new Error(`Invalid scope "${s}". Valid scopes: ${VALID_API_KEY_SCOPES.join(", ")}.`);
    }
  }
  return scopes as ApiKeyScope[];
}

function ttlToExpiresAtIso(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

async function apiKeyAdd(command: cli.IApiKeyAddCommand): Promise<void> {
  const scopes = validateApiKeyScopes(command.scopes as unknown as string[]);
  const request: ApiKeyCreationRequest = { name: command.name, scopes };
  if (isCommandOptionSpecified(command.ttl)) {
    request.expires_at = ttlToExpiresAtIso(command.ttl);
  }
  const created: ApiKeyWithSecret = await sdk.addApiKey(request);
  log(`Successfully created the "${command.name}" API key:`);
  log(`  ${created.key}`);
  log("");
  log("Make sure to save this key somewhere safe - you won't be able to view it from the CLI again.");
  log("");
  log(`  Id:      ${created.id}`);
  log(`  Scopes:  ${created.scopes.join(", ")}`);
  log(`  Expires: ${created.expires_at ? formatDate(new Date(created.expires_at).getTime()) : "Never"}`);
}

async function apiKeyPatch(command: cli.IApiKeyPatchCommand): Promise<void> {
  const willUpdateName: boolean = isCommandOptionSpecified(command.newName);
  const willUpdateScopes: boolean = isCommandOptionSpecified(command.scopes);
  const willUpdateTtl: boolean = isCommandOptionSpecified(command.ttl);

  if (!willUpdateName && !willUpdateScopes && !willUpdateTtl) {
    throw new Error("At least one of --name, --scopes, or --ttl must be provided.");
  }

  const update: ApiKeyUpdateRequest = {};
  if (willUpdateName) {
    update.name = command.newName;
  }
  if (willUpdateScopes) {
    update.scopes = validateApiKeyScopes(command.scopes as unknown as string[]);
  }
  if (willUpdateTtl) {
    update.expires_at = ttlToExpiresAtIso(command.ttl);
  }

  const updated: ApiKey = await sdk.patchApiKey(command.id, update);
  let logMessage: string = `Successfully updated the "${updated.name}" API key`;
  const changes: string[] = [];
  if (willUpdateName) changes.push("name");
  if (willUpdateScopes) changes.push("scopes");
  if (willUpdateTtl) changes.push("expiration");
  logMessage += ` (${changes.join(", ")}).`;
  log(logMessage);
}

async function apiKeyList(command: cli.IApiKeyListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);
  const keys: ApiKey[] = await sdk.getApiKeys(command.includeRevoked);
  printApiKeys(command.format, keys);
}

async function apiKeyRemove(command: cli.IApiKeyRemoveCommand): Promise<void> {
  const wasConfirmed: boolean = await confirmDestructive(command);
  if (!wasConfirmed) {
    log("API key revocation cancelled.");
    return;
  }
  const result = await sdk.revokeApiKey(command.id);
  log(`Successfully revoked the API key with id "${result.id}".`);
}

function appAdd(command: cli.IAppAddCommand): Promise<void> {
  return sdk.addApp(command.appName).then((app: App): Promise<void> => {
    log('Successfully added the "' + command.appName + '" app, along with the following default deployments:');
    const deploymentListCommand: cli.IDeploymentListCommand = {
      type: cli.CommandType.deploymentList,
      appName: app.name,
      format: "table",
      displayKeys: true,
    };
    return deploymentList(deploymentListCommand, /*showPackage=*/ false);
  });
}

function appList(command: cli.IAppListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);
  return sdk.getApps().then((retrievedApps: App[]): void => {
    printAppList(command.format, retrievedApps);
  });
}

function appRemove(command: cli.IAppRemoveCommand): Promise<void> {
  return confirmDestructive(
    command,
    "Are you sure you want to remove this app? Note that its deployment keys will be PERMANENTLY unrecoverable."
  ).then((wasConfirmed: boolean) => {
    if (wasConfirmed) {
      return sdk.removeApp(command.appName).then((): void => {
        log('Successfully removed the "' + command.appName + '" app.');
      });
    }

    log("App removal cancelled.");
  });
}

function appRename(command: cli.IAppRenameCommand): Promise<void> {
  return sdk.renameApp(command.currentAppName, command.newAppName).then((): void => {
    log('Successfully renamed the "' + command.currentAppName + '" app to "' + command.newAppName + '".');
  });
}

export const createEmptyTempReleaseFolder = (folderPath: string) => {
  return deleteFolder(folderPath).then(() => {
    fs.mkdirSync(folderPath);
  });
};

function appTransfer(command: cli.IAppTransferCommand): Promise<void> {
  throwForInvalidEmail(command.email);

  return confirmDestructive(command).then((wasConfirmed: boolean) => {
    if (wasConfirmed) {
      return sdk.transferApp(command.appName, command.email).then((): void => {
        log(
          'Successfully transferred the ownership of app "' + command.appName + '" to the account with email "' + command.email + '".'
        );
      });
    }

    log("App transfer cancelled.");
  });
}

function addCollaborator(command: cli.ICollaboratorAddCommand): Promise<void> {
  throwForInvalidEmail(command.email);

  return sdk.addCollaborator(command.appName, command.email).then((): void => {
    log('Successfully added "' + command.email + '" as a collaborator to the app "' + command.appName + '".');
  });
}

function listCollaborators(command: cli.ICollaboratorListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return sdk.getCollaborators(command.appName).then((retrievedCollaborators: CollaboratorMap): void => {
    printCollaboratorsList(command.format, retrievedCollaborators);
  });
}

function removeCollaborator(command: cli.ICollaboratorRemoveCommand): Promise<void> {
  throwForInvalidEmail(command.email);

  return confirm(undefined, command.nonInteractive || !!command.force).then((wasConfirmed: boolean) => {
    if (wasConfirmed) {
      return sdk.removeCollaborator(command.appName, command.email).then((): void => {
        log('Successfully removed "' + command.email + '" as a collaborator from the app "' + command.appName + '".');
      });
    }

    log("App collaborator removal cancelled.");
  });
}

function deleteConnectionInfoCache(printMessage: boolean = true): void {
  try {
    fs.unlinkSync(configFilePath);

    if (printMessage) {
      log(`Logged out. The session file at ${chalk.cyan(configFilePath)} has been deleted.`);
    }
  } catch (ex) {}
}

function deleteFolder(folderPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    rimraf(folderPath, (err: any) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function deploymentAdd(command: cli.IDeploymentAddCommand): Promise<void> {
  return sdk.addDeployment(command.appName, command.deploymentName, command.key).then((deployment: Deployment): void => {
    log(
      'Successfully added the "' +
        command.deploymentName +
        '" deployment with key "' +
        deployment.key +
        '" to the "' +
        command.appName +
        '" app.'
    );
  });
}

function deploymentHistoryClear(command: cli.IDeploymentHistoryClearCommand): Promise<void> {
  return confirmDestructive(command).then((wasConfirmed: boolean) => {
    if (wasConfirmed) {
      return sdk.clearDeploymentHistory(command.appName, command.deploymentName).then((): void => {
        log(
          'Successfully cleared the release history associated with the "' +
            command.deploymentName +
            '" deployment from the "' +
            command.appName +
            '" app.'
        );
      });
    }

    log("Clear deployment cancelled.");
  });
}

export const deploymentList = (command: cli.IDeploymentListCommand, showPackage: boolean = true): Promise<void> => {
  throwForInvalidOutputFormat(command.format);
  let deployments: Deployment[];

  return sdk
    .getDeployments(command.appName)
    .then((retrievedDeployments: Deployment[]) => {
      deployments = retrievedDeployments;
      if (showPackage) {
        const metricsPromises: Promise<void>[] = deployments.map((deployment: Deployment) => {
          if (deployment.package) {
            return sdk.getDeploymentMetrics(command.appName, deployment.name).then((metrics: DeploymentMetrics): void => {
              if (metrics[deployment.package.label]) {
                const totalActive: number = getTotalActiveFromDeploymentMetrics(metrics);
                (<PackageWithMetrics>deployment.package).metrics = {
                  active: metrics[deployment.package.label].active,
                  downloaded: metrics[deployment.package.label].downloaded,
                  failed: metrics[deployment.package.label].failed,
                  installed: metrics[deployment.package.label].installed,
                  totalActive: totalActive,
                };
              }
            });
          } else {
            return Promise.resolve();
          }
        });

        return Promise.all(metricsPromises).then(() => undefined);
      }
    })
    .then(() => {
      printDeploymentList(command, deployments, showPackage);
    });
};

function deploymentRemove(command: cli.IDeploymentRemoveCommand): Promise<void> {
  return confirmDestructive(
    command,
    "Are you sure you want to remove this deployment? Note that its deployment key will be PERMANENTLY unrecoverable."
  ).then((wasConfirmed: boolean) => {
    if (wasConfirmed) {
      return sdk.removeDeployment(command.appName, command.deploymentName).then((): void => {
        log('Successfully removed the "' + command.deploymentName + '" deployment from the "' + command.appName + '" app.');
      });
    }

    log("Deployment removal cancelled.");
  });
}

function deploymentRename(command: cli.IDeploymentRenameCommand): Promise<void> {
  return sdk.renameDeployment(command.appName, command.currentDeploymentName, command.newDeploymentName).then((): void => {
    log(
      'Successfully renamed the "' +
        command.currentDeploymentName +
        '" deployment to "' +
        command.newDeploymentName +
        '" for the "' +
        command.appName +
        '" app.'
    );
  });
}

function deploymentHistory(command: cli.IDeploymentHistoryCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return Promise.all([
    sdk.getAccountInfo(),
    sdk.getDeploymentHistory(command.appName, command.deploymentName),
    sdk.getDeploymentMetrics(command.appName, command.deploymentName),
  ]).then(([account, deploymentHistory, metrics]) => {
    const totalActive: number = getTotalActiveFromDeploymentMetrics(metrics);
    deploymentHistory.forEach((packageObject: Package) => {
      if (metrics[packageObject.label]) {
        (<PackageWithMetrics>packageObject).metrics = {
          active: metrics[packageObject.label].active,
          downloaded: metrics[packageObject.label].downloaded,
          failed: metrics[packageObject.label].failed,
          installed: metrics[packageObject.label].installed,
          totalActive: totalActive,
        };
      }
    });
    printDeploymentHistory(command, <Package[]>deploymentHistory, account.email);
  });
}

function deserializeConnectionInfo(): ILoginConnectionInfo {
  try {
    const savedConnection: string = fs.readFileSync(configFilePath, {
      encoding: "utf8",
    });
    let connectionInfo: ILegacyLoginConnectionInfo | ILoginConnectionInfo = JSON.parse(savedConnection);

    // If the connection info is in the legacy format, convert it to the modern format
    if ((<ILegacyLoginConnectionInfo>connectionInfo).accessKeyName) {
      connectionInfo = <ILoginConnectionInfo>{
        accessKey: (<ILegacyLoginConnectionInfo>connectionInfo).accessKeyName,
      };
    }

    const connInfo = <ILoginConnectionInfo>connectionInfo;

    return connInfo;
  } catch (ex) {
    return;
  }
}

export function execute(command: cli.ICommand) {
  connectionInfo = deserializeConnectionInfo();
  command.nonInteractive = resolveNonInteractive(command);

  return Promise.resolve().then(() => {
    switch (command.type) {
      // Must not be logged in
      case cli.CommandType.login:
      case cli.CommandType.register:
        if (connectionInfo) {
          throw new Error("You are already logged in from this machine.");
        }
        break;

      // Must be logged in
      default:
        if (!!sdk) break; // Used by unit tests to skip authentication

        if (!connectionInfo) {
          throw new Error("You are not currently logged in. Run 'aether login' to authenticate with Aether.");
        }

        sdk = getSdk(connectionInfo.accessKey, CLI_HEADERS, connectionInfo.customServerUrl);
        break;
    }

    switch (command.type) {
      case cli.CommandType.accessKeyAdd:
        return accessKeyAdd(<cli.IAccessKeyAddCommand>command);

      case cli.CommandType.accessKeyPatch:
        return accessKeyPatch(<cli.IAccessKeyPatchCommand>command);

      case cli.CommandType.accessKeyList:
        return accessKeyList(<cli.IAccessKeyListCommand>command);

      case cli.CommandType.accessKeyRemove:
        return accessKeyRemove(<cli.IAccessKeyRemoveCommand>command);

      case cli.CommandType.apiKeyAdd:
        return apiKeyAdd(<cli.IApiKeyAddCommand>command);

      case cli.CommandType.apiKeyPatch:
        return apiKeyPatch(<cli.IApiKeyPatchCommand>command);

      case cli.CommandType.apiKeyList:
        return apiKeyList(<cli.IApiKeyListCommand>command);

      case cli.CommandType.apiKeyRemove:
        return apiKeyRemove(<cli.IApiKeyRemoveCommand>command);

      case cli.CommandType.appAdd:
        return appAdd(<cli.IAppAddCommand>command);

      case cli.CommandType.appList:
        return appList(<cli.IAppListCommand>command);

      case cli.CommandType.appRemove:
        return appRemove(<cli.IAppRemoveCommand>command);

      case cli.CommandType.appRename:
        return appRename(<cli.IAppRenameCommand>command);

      case cli.CommandType.appTransfer:
        return appTransfer(<cli.IAppTransferCommand>command);

      case cli.CommandType.collaboratorAdd:
        return addCollaborator(<cli.ICollaboratorAddCommand>command);

      case cli.CommandType.collaboratorList:
        return listCollaborators(<cli.ICollaboratorListCommand>command);

      case cli.CommandType.collaboratorRemove:
        return removeCollaborator(<cli.ICollaboratorRemoveCommand>command);

      case cli.CommandType.debug:
        return debugCommand(<cli.IDebugCommand>command);

      case cli.CommandType.deploymentAdd:
        return deploymentAdd(<cli.IDeploymentAddCommand>command);

      case cli.CommandType.deploymentHistoryClear:
        return deploymentHistoryClear(<cli.IDeploymentHistoryClearCommand>command);

      case cli.CommandType.deploymentHistory:
        return deploymentHistory(<cli.IDeploymentHistoryCommand>command);

      case cli.CommandType.deploymentList:
        return deploymentList(<cli.IDeploymentListCommand>command);

      case cli.CommandType.deploymentRemove:
        return deploymentRemove(<cli.IDeploymentRemoveCommand>command);

      case cli.CommandType.deploymentRename:
        return deploymentRename(<cli.IDeploymentRenameCommand>command);

      case cli.CommandType.login:
        return login(<cli.ILoginCommand>command);

      case cli.CommandType.logout:
        return logout(command);

      case cli.CommandType.patch:
        return patch(<cli.IPatchCommand>command);

      case cli.CommandType.promote:
        return promote(<cli.IPromoteCommand>command);

      case cli.CommandType.register:
        return register(<cli.IRegisterCommand>command);

      case cli.CommandType.release:
        return release(<cli.IReleaseCommand>command);

      case cli.CommandType.releaseReact:
        return releaseReact(<cli.IReleaseReactCommand>command);

      case cli.CommandType.rollback:
        return rollback(<cli.IRollbackCommand>command);

      case cli.CommandType.sessionList:
        return sessionList(<cli.ISessionListCommand>command);

      case cli.CommandType.sessionRemove:
        return sessionRemove(<cli.ISessionRemoveCommand>command);

      case cli.CommandType.whoami:
        return whoami(command);

      default:
        // We should never see this message as invalid commands should be caught by the argument parser.
        throw new Error("Invalid command:  " + JSON.stringify(command));
    }
  });
}

function getTotalActiveFromDeploymentMetrics(metrics: DeploymentMetrics): number {
  let totalActive = 0;
  Object.keys(metrics).forEach((label: string) => {
    totalActive += metrics[label].active;
  });

  return totalActive;
}

async function login(command: cli.ILoginCommand): Promise<void> {
  const serverUrl = command.serverUrl || DEFAULT_AETHER_SERVER_URL;

  if (command.accessKey) {
    sdk = getSdk(command.accessKey, CLI_HEADERS, serverUrl);
    const authenticated = await sdk.isAuthenticated();
    if (!authenticated) {
      throw new Error("Invalid access key.");
    }
    serializeConnectionInfo(command.accessKey, /*preserveAccessKeyOnLogout*/ true, serverUrl);
    return;
  }

  if (command.nonInteractive) {
    throw new Error("Interactive login is unavailable in non-interactive mode. Re-run with --accessKey <key>.");
  }

  const { email, password } = await promptForLoginCredentials();
  if (!email) {
    throw new Error("Email is required.");
  }
  if (!password) {
    throw new Error("Password is required.");
  }

  const url = serverUrl.replace(/\/$/, "") + "/v1/auth/login";
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    throw new Error(`Unable to reach Aether at ${serverUrl}. Are you offline, or behind a firewall or proxy?`);
  }

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || body.message || `Login failed (HTTP ${res.status}).`);
  }

  const accessKey: string = body.accessKey;
  if (!accessKey) {
    throw new Error("Server returned an empty access key.");
  }

  sdk = getSdk(accessKey, CLI_HEADERS, serverUrl);
  serializeConnectionInfo(accessKey, /*preserveAccessKeyOnLogout*/ false, serverUrl);
  log(chalk.green(`Successfully logged in as ${email}.`));
}

function logout(command: cli.ICommand): Promise<void> {
  sdk = null;
  deleteConnectionInfoCache();
  return Promise.resolve();
}

function formatDate(unixOffset: number): string {
  const date: moment.Moment = moment(unixOffset);
  const now: moment.Moment = moment();
  if (Math.abs(now.diff(date, "days")) < 30) {
    return date.fromNow(); // "2 hours ago"
  } else if (now.year() === date.year()) {
    return date.format("MMM D"); // "Nov 6"
  } else {
    return date.format("MMM D, YYYY"); // "Nov 6, 2014"
  }
}

function printAppList(format: string, apps: App[]): void {
  if (format === "json") {
    printJson(apps);
  } else if (format === "table") {
    const headers = ["Name", "Deployments"];
    printTable(headers, (dataSource: any[]): void => {
      apps.forEach((app: App, index: number): void => {
        const row = [app.name, wordwrap(50)(app.deployments.join(", "))];
        dataSource.push(row);
      });
    });
  }
}

function getCollaboratorDisplayName(email: string, collaboratorProperties: CollaboratorProperties): string {
  return collaboratorProperties.permission === AccountManager.AppPermission.OWNER ? email + chalk.magenta(" (Owner)") : email;
}

function printCollaboratorsList(format: string, collaborators: CollaboratorMap): void {
  if (format === "json") {
    const dataSource = { collaborators: collaborators };
    printJson(dataSource);
  } else if (format === "table") {
    const headers = ["E-mail Address"];
    printTable(headers, (dataSource: any[]): void => {
      Object.keys(collaborators).forEach((email: string): void => {
        const row = [getCollaboratorDisplayName(email, collaborators[email])];
        dataSource.push(row);
      });
    });
  }
}

function printDeploymentList(command: cli.IDeploymentListCommand, deployments: Deployment[], showPackage: boolean = true): void {
  if (command.format === "json") {
    printJson(deployments);
  } else if (command.format === "table") {
    const headers = ["Name"];
    if (command.displayKeys) {
      headers.push("Deployment Key");
    }

    if (showPackage) {
      headers.push("Update Metadata");
      headers.push("Install Metrics");
    }

    printTable(headers, (dataSource: any[]): void => {
      deployments.forEach((deployment: Deployment): void => {
        const row = [deployment.name];
        if (command.displayKeys) {
          row.push(deployment.key);
        }

        if (showPackage) {
          row.push(getPackageString(deployment.package));
          row.push(getPackageMetricsString(deployment.package));
        }

        dataSource.push(row);
      });
    });
  }
}

function printDeploymentHistory(command: cli.IDeploymentHistoryCommand, deploymentHistory: Package[], currentUserEmail: string): void {
  if (command.format === "json") {
    printJson(deploymentHistory);
  } else if (command.format === "table") {
    const headers = ["Label", "Release Time", "App Version", "Mandatory"];
    if (command.displayAuthor) {
      headers.push("Released By");
    }

    headers.push("Description", "Install Metrics");

    printTable(headers, (dataSource: any[]) => {
      deploymentHistory.forEach((packageObject: Package) => {
        let releaseTime: string = formatDate(packageObject.uploadTime);
        let releaseSource: string;
        if (packageObject.releaseMethod === "Promote") {
          releaseSource = `Promoted ${packageObject.originalLabel} from "${packageObject.originalDeployment}"`;
        } else if (packageObject.releaseMethod === "Rollback") {
          const labelNumber: number = parseInt(packageObject.label.substring(1));
          const lastLabel: string = "v" + (labelNumber - 1);
          releaseSource = `Rolled back ${lastLabel} to ${packageObject.originalLabel}`;
        }

        if (releaseSource) {
          releaseTime += "\n" + chalk.magenta(`(${releaseSource})`).toString();
        }

        let row: string[] = [packageObject.label, releaseTime, packageObject.appVersion, packageObject.isMandatory ? "Yes" : "No"];
        if (command.displayAuthor) {
          let releasedBy: string = packageObject.releasedBy ? packageObject.releasedBy : "";
          if (currentUserEmail && releasedBy === currentUserEmail) {
            releasedBy = "You";
          }

          row.push(releasedBy);
        }

        row.push(packageObject.description ? wordwrap(30)(packageObject.description) : "");
        row.push(getPackageMetricsString(packageObject) + (packageObject.isDisabled ? `\n${chalk.green("Disabled:")} Yes` : ""));
        if (packageObject.isDisabled) {
          row = row.map((cellContents: string) => applyChalkSkippingLineBreaks(cellContents, (<any>chalk).dim));
        }

        dataSource.push(row);
      });
    });
  }
}

function applyChalkSkippingLineBreaks(applyString: string, chalkMethod: (string: string) => any): string {
  // Used to prevent "chalk" from applying styles to linebreaks which
  // causes table border chars to have the style applied as well.
  return applyString
    .split("\n")
    .map((token: string) => chalkMethod(token))
    .join("\n");
}

function getPackageString(packageObject: Package): string {
  if (!packageObject) {
    return chalk.magenta("No updates released").toString();
  }

  let packageString: string =
    chalk.green("Label: ") +
    packageObject.label +
    "\n" +
    chalk.green("App Version: ") +
    packageObject.appVersion +
    "\n" +
    chalk.green("Mandatory: ") +
    (packageObject.isMandatory ? "Yes" : "No") +
    "\n" +
    chalk.green("Release Time: ") +
    formatDate(packageObject.uploadTime) +
    "\n" +
    chalk.green("Released By: ") +
    (packageObject.releasedBy ? packageObject.releasedBy : "") +
    (packageObject.description ? wordwrap(70)("\n" + chalk.green("Description: ") + packageObject.description) : "");

  if (packageObject.isDisabled) {
    packageString += `\n${chalk.green("Disabled:")} Yes`;
  }

  return packageString;
}

function getPackageMetricsString(obj: Package): string {
  const packageObject = <PackageWithMetrics>obj;
  const rolloutString: string =
    obj && obj.rollout && obj.rollout !== 100 ? `\n${chalk.green("Rollout:")} ${obj.rollout.toLocaleString()}%` : "";

  if (!packageObject || !packageObject.metrics) {
    return chalk.magenta("No installs recorded").toString() + (rolloutString || "");
  }

  const activePercent: number = packageObject.metrics.totalActive
    ? (packageObject.metrics.active / packageObject.metrics.totalActive) * 100
    : 0.0;
  let percentString: string;
  if (activePercent === 100.0) {
    percentString = "100%";
  } else if (activePercent === 0.0) {
    percentString = "0%";
  } else {
    percentString = activePercent.toPrecision(2) + "%";
  }

  const numPending: number = packageObject.metrics.downloaded - packageObject.metrics.installed - packageObject.metrics.failed;
  let returnString: string =
    chalk.green("Active: ") +
    percentString +
    " (" +
    packageObject.metrics.active.toLocaleString() +
    " of " +
    packageObject.metrics.totalActive.toLocaleString() +
    ")\n" +
    chalk.green("Total: ") +
    packageObject.metrics.installed.toLocaleString();

  if (numPending > 0) {
    returnString += " (" + numPending.toLocaleString() + " pending)";
  }

  if (packageObject.metrics.failed) {
    returnString += "\n" + chalk.green("Rollbacks: ") + chalk.red(packageObject.metrics.failed.toLocaleString() + "");
  }

  if (rolloutString) {
    returnString += rolloutString;
  }

  return returnString;
}

function getReactNativeProjectAppVersion(command: cli.IReleaseReactCommand, projectName: string): Promise<string> {
  log(chalk.cyan(`Detecting ${command.platform} app version:\n`));

  if (command.platform === "ios") {
    let resolvedPlistFile: string = command.plistFile;
    if (resolvedPlistFile) {
      // If a plist file path is explicitly provided, then we don't
      // need to attempt to "resolve" it within the well-known locations.
      if (!fileExists(resolvedPlistFile)) {
        throw new Error("The specified plist file doesn't exist. Please check that the provided path is correct.");
      }
    } else {
      // Allow the plist prefix to be specified with or without a trailing
      // separator character, but prescribe the use of a hyphen when omitted,
      // since this is the most commonly used convetion for plist files.
      if (command.plistFilePrefix && /.+[^-.]$/.test(command.plistFilePrefix)) {
        command.plistFilePrefix += "-";
      }

      const iOSDirectory: string = "ios";
      const plistFileName = `${command.plistFilePrefix || ""}Info.plist`;

      const knownLocations = [path.join(iOSDirectory, projectName, plistFileName), path.join(iOSDirectory, plistFileName)];

      resolvedPlistFile = (<any>knownLocations).find(fileExists);

      if (!resolvedPlistFile) {
        throw new Error(
          `Unable to find either of the following plist files in order to infer your app's binary version: "${knownLocations.join(
            '", "'
          )}". If your plist has a different name, or is located in a different directory, consider using either the "--plistFile" or "--plistFilePrefix" parameters to help inform the CLI how to find it.`
        );
      }
    }

    const plistContents = fs.readFileSync(resolvedPlistFile).toString();

    let parsedPlist;

    try {
      parsedPlist = plist.parse(plistContents);
    } catch (e) {
      throw new Error(`Unable to parse "${resolvedPlistFile}". Please ensure it is a well-formed plist file.`);
    }

    if (parsedPlist && parsedPlist.CFBundleShortVersionString) {
      if (isValidVersion(parsedPlist.CFBundleShortVersionString)) {
        log(`Using the target binary version value "${parsedPlist.CFBundleShortVersionString}" from "${resolvedPlistFile}".\n`);
        return Promise.resolve(parsedPlist.CFBundleShortVersionString);
      } else {
        if (parsedPlist.CFBundleShortVersionString !== "$(MARKETING_VERSION)") {
          throw new Error(
            `The "CFBundleShortVersionString" key in the "${resolvedPlistFile}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`
          );
        }

        return getAppVersionFromXcodeProject(command, projectName);
      }
    } else {
      throw new Error(`The "CFBundleShortVersionString" key doesn't exist within the "${resolvedPlistFile}" file.`);
    }
  } else if (command.platform === "android") {
    let buildGradlePath: string = path.join("android", "app");
    if (command.gradleFile) {
      buildGradlePath = command.gradleFile;
    }
    if (fs.lstatSync(buildGradlePath).isDirectory()) {
      buildGradlePath = path.join(buildGradlePath, "build.gradle");
    }

    if (fileDoesNotExistOrIsDirectory(buildGradlePath)) {
      throw new Error(`Unable to find gradle file "${buildGradlePath}".`);
    }

    return g2js
      .parseFile(buildGradlePath)
      .catch(() => {
        throw new Error(`Unable to parse the "${buildGradlePath}" file. Please ensure it is a well-formed Gradle file.`);
      })
      .then((buildGradle: any) => {
        let versionName: string = null;

        // First 'if' statement was implemented as workaround for case
        // when 'build.gradle' file contains several 'android' nodes.
        // In this case 'buildGradle.android' prop represents array instead of object
        // due to parsing issue in 'g2js.parseFile' method.
        if (buildGradle.android instanceof Array) {
          for (let i = 0; i < buildGradle.android.length; i++) {
            const gradlePart = buildGradle.android[i];
            if (gradlePart.defaultConfig && gradlePart.defaultConfig.versionName) {
              versionName = gradlePart.defaultConfig.versionName;
              break;
            }
          }
        } else if (buildGradle.android && buildGradle.android.defaultConfig && buildGradle.android.defaultConfig.versionName) {
          versionName = buildGradle.android.defaultConfig.versionName;
        } else {
          throw new Error(
            `The "${buildGradlePath}" file doesn't specify a value for the "android.defaultConfig.versionName" property.`
          );
        }

        if (typeof versionName !== "string") {
          throw new Error(
            `The "android.defaultConfig.versionName" property value in "${buildGradlePath}" is not a valid string. If this is expected, consider using the --targetBinaryVersion option to specify the value manually.`
          );
        }

        let appVersion: string = versionName.replace(/"/g, "").trim();

        if (isValidVersion(appVersion)) {
          // The versionName property is a valid semver string,
          // so we can safely use that and move on.
          log(`Using the target binary version value "${appVersion}" from "${buildGradlePath}".\n`);
          return appVersion;
        } else if (/^\d.*/.test(appVersion)) {
          // The versionName property isn't a valid semver string,
          // but it starts with a number, and therefore, it can't
          // be a valid Gradle property reference.
          throw new Error(
            `The "android.defaultConfig.versionName" property in the "${buildGradlePath}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`
          );
        }

        // The version property isn't a valid semver string
        // so we assume it is a reference to a property variable.
        const propertyName = appVersion.replace("project.", "");
        const propertiesFileName = "gradle.properties";

        const knownLocations = [path.join("android", "app", propertiesFileName), path.join("android", propertiesFileName)];

        // Search for gradle properties across all `gradle.properties` files
        let propertiesFile: string = null;
        for (let i = 0; i < knownLocations.length; i++) {
          propertiesFile = knownLocations[i];
          if (fileExists(propertiesFile)) {
            const propertiesContent: string = fs.readFileSync(propertiesFile).toString();
            try {
              const parsedProperties: any = properties.parse(propertiesContent);
              appVersion = parsedProperties[propertyName];
              if (appVersion) {
                break;
              }
            } catch (e) {
              throw new Error(`Unable to parse "${propertiesFile}". Please ensure it is a well-formed properties file.`);
            }
          }
        }

        if (!appVersion) {
          throw new Error(`No property named "${propertyName}" exists in the "${propertiesFile}" file.`);
        }

        if (!isValidVersion(appVersion)) {
          throw new Error(
            `The "${propertyName}" property in the "${propertiesFile}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`
          );
        }

        log(`Using the target binary version value "${appVersion}" from the "${propertyName}" key in the "${propertiesFile}" file.\n`);
        return appVersion.toString();
      });
  } else {
    throw new Error(`Unsupported platform "${command.platform}". Use "ios" or "android".`);
  }
}

function getAppVersionFromXcodeProject(command: cli.IReleaseReactCommand, projectName: string): Promise<string> {
  const pbxprojFileName = "project.pbxproj";
  let resolvedPbxprojFile: string = command.xcodeProjectFile;
  if (resolvedPbxprojFile) {
    // If the xcode project file path is explicitly provided, then we don't
    // need to attempt to "resolve" it within the well-known locations.
    if (!resolvedPbxprojFile.endsWith(pbxprojFileName)) {
      // Specify path to pbxproj file if the provided file path is an Xcode project file.
      resolvedPbxprojFile = path.join(resolvedPbxprojFile, pbxprojFileName);
    }
    if (!fileExists(resolvedPbxprojFile)) {
      throw new Error("The specified pbx project file doesn't exist. Please check that the provided path is correct.");
    }
  } else {
    const iOSDirectory = "ios";
    const xcodeprojDirectory = `${projectName}.xcodeproj`;
    const pbxprojKnownLocations = [
      path.join(iOSDirectory, xcodeprojDirectory, pbxprojFileName),
      path.join(iOSDirectory, pbxprojFileName),
    ];
    resolvedPbxprojFile = pbxprojKnownLocations.find(fileExists);

    if (!resolvedPbxprojFile) {
      throw new Error(
        `Unable to find either of the following pbxproj files in order to infer your app's binary version: "${pbxprojKnownLocations.join(
          '", "'
        )}".`
      );
    }
  }

  const xcodeProj = xcode.project(resolvedPbxprojFile).parseSync();
  const marketingVersion = xcodeProj.getBuildProperty("MARKETING_VERSION", command.buildConfigurationName, command.xcodeTargetName);
  if (!isValidVersion(marketingVersion)) {
    throw new Error(
      `The "MARKETING_VERSION" key in the "${resolvedPbxprojFile}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`
    );
  }
  console.log(`Using the target binary version value "${marketingVersion}" from "${resolvedPbxprojFile}".\n`);

  return Promise.resolve(marketingVersion);
}

function printJson(object: any): void {
  log(JSON.stringify(object, /*replacer=*/ null, /*spacing=*/ 2));
}

function printAccessKeys(format: string, keys: AccessKey[]): void {
  if (format === "json") {
    printJson(keys);
  } else if (format === "table") {
    printTable(["Name", "Created", "Expires"], (dataSource: any[]): void => {
      const now = new Date().getTime();

      function isExpired(key: AccessKey): boolean {
        return now >= key.expires;
      }

      function keyToTableRow(key: AccessKey, dim: boolean): string[] {
        const row: string[] = [key.friendlyName, key.createdTime ? formatDate(key.createdTime) : "", formatDate(key.expires)];

        if (dim) {
          row.forEach((col: string, index: number) => {
            row[index] = (<any>chalk).dim(col);
          });
        }

        return row;
      }

      keys.forEach((key: AccessKey) => !isExpired(key) && dataSource.push(keyToTableRow(key, /*dim*/ false)));
      keys.forEach((key: AccessKey) => isExpired(key) && dataSource.push(keyToTableRow(key, /*dim*/ true)));
    });
  }
}

function printSessions(format: string, sessions: Session[]): void {
  if (format === "json") {
    printJson(sessions);
  } else if (format === "table") {
    printTable(["Created From", "Logged in"], (dataSource: any[]): void => {
      sessions.forEach((session: Session) => dataSource.push([session.createdBy, formatDate(session.loggedInTime)]));
    });
  }
}

function printApiKeys(format: string, keys: ApiKey[]): void {
  if (format === "json") {
    printJson(keys);
  } else if (format === "table") {
    printTable(["Id", "Name", "Scopes", "Last Used", "Expires", "Status"], (dataSource: any[]): void => {
      function keyToRow(key: ApiKey, dim: boolean): string[] {
        const expires: string = key.expires_at ? formatDate(new Date(key.expires_at).getTime()) : "Never";
        const lastUsed: string = key.last_used_at ? formatDate(new Date(key.last_used_at).getTime()) : "Never";
        const status: string = key.revoked_at ? "Revoked" : "Active";
        const row: string[] = [key.id, key.name, key.scopes.join(", "), lastUsed, expires, status];
        if (dim) {
          row.forEach((col: string, index: number) => {
            row[index] = (<any>chalk).dim(col);
          });
        }
        return row;
      }

      keys.forEach((key: ApiKey) => !key.revoked_at && dataSource.push(keyToRow(key, /*dim*/ false)));
      keys.forEach((key: ApiKey) => key.revoked_at && dataSource.push(keyToRow(key, /*dim*/ true)));
    });
  }
}

function printTable(columnNames: string[], readData: (dataSource: any[]) => void): void {
  const table = new Table({
    head: columnNames,
    style: { head: ["cyan"] },
  });

  readData(table);

  log(table.toString());
}

async function register(command: cli.IRegisterCommand): Promise<void> {
  const serverUrl = command.serverUrl || DEFAULT_AETHER_SERVER_URL;

  if (command.nonInteractive) {
    throw new Error("Account registration is unavailable in non-interactive mode.");
  }

  const { email, name, password, confirmPassword } = await promptForRegistration();

  if (!email) {
    throw new Error("Email is required.");
  }
  if (!password) {
    throw new Error("Password is required.");
  }
  if (password !== confirmPassword) {
    throw new Error("Passwords do not match.");
  }

  const reqBody: { email: string; password: string; name?: string } = { email, password };
  if (name) {
    reqBody.name = name;
  }

  const url = serverUrl.replace(/\/$/, "") + "/v1/auth/register";
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(reqBody),
    });
  } catch (err) {
    throw new Error(`Unable to reach Aether at ${serverUrl}. Are you offline, or behind a firewall or proxy?`);
  }

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const lines = body.errors
        .map((e: any) => (e && typeof e === "object" ? e.message || JSON.stringify(e) : String(e)))
        .join("\n  ");
      throw new Error(`Registration failed:\n  ${lines}`);
    }
    throw new Error(body.error || body.message || `Registration failed (HTTP ${res.status}).`);
  }

  log(chalk.green(`Account created for ${email}.`));
  log(`Check your inbox for a verification link, then run ${chalk.cyan("aether login")} to sign in.`);
}

function promote(command: cli.IPromoteCommand): Promise<void> {
  const packageInfo: PackageInfo = {
    appVersion: command.appStoreVersion,
    description: command.description,
    label: command.label,
    isDisabled: command.disabled,
    isMandatory: command.mandatory,
    rollout: command.rollout,
  };

  return sdk
    .promote(command.appName, command.sourceDeploymentName, command.destDeploymentName, packageInfo)
    .then((): void => {
      log(
        "Successfully promoted " +
          (command.label !== null ? '"' + command.label + '" of ' : "") +
          'the "' +
          command.sourceDeploymentName +
          '" deployment of the "' +
          command.appName +
          '" app to the "' +
          command.destDeploymentName +
          '" deployment.'
      );
    })
    .catch((err: AetherError) => releaseErrorHandler(err, command));
}

function patch(command: cli.IPatchCommand): Promise<void> {
  const packageInfo: PackageInfo = {
    appVersion: command.appStoreVersion,
    description: command.description,
    isMandatory: command.mandatory,
    isDisabled: command.disabled,
    rollout: command.rollout,
  };

  for (const updateProperty in packageInfo) {
    if ((<any>packageInfo)[updateProperty] !== null) {
      return sdk.patchRelease(command.appName, command.deploymentName, command.label, packageInfo).then((): void => {
        log(
          `Successfully updated the "${command.label ? command.label : `latest`}" release of "${command.appName}" app's "${
            command.deploymentName
          }" deployment.`
        );
      });
    }
  }

  throw new Error("At least one property must be specified to patch a release.");
}

export const release = (command: cli.IReleaseCommand): Promise<void> => {
  if (isBinaryOrZip(command.package)) {
    throw new Error(
      "It is unnecessary to package releases in a .zip or binary file. Please specify the direct path to the update content's directory (e.g. /platforms/ios/www) or file (e.g. main.jsbundle)."
    );
  }

  throwForInvalidSemverRange(command.appStoreVersion);
  const filePath: string = command.package;
  let isSingleFilePackage: boolean = true;

  if (fs.lstatSync(filePath).isDirectory()) {
    isSingleFilePackage = false;
  }

  const updateMetadata: PackageInfo = {
    description: command.description,
    isDisabled: command.disabled,
    isMandatory: command.mandatory,
    rollout: command.rollout,
  };

  return sdk
    .isAuthenticated(true)
    .then((isAuth: boolean) => {
      log("Uploading release package...");
      return sdk.release(command.appName, command.deploymentName, filePath, command.appStoreVersion, updateMetadata);
    })
    .then((): void => {
      log(
        'Successfully released an update containing the "' +
          command.package +
          '" ' +
          (isSingleFilePackage ? "file" : "directory") +
          ' to the "' +
          command.deploymentName +
          '" deployment of the "' +
          command.appName +
          '" app.'
      );
    })
    .catch((err: AetherError) => releaseErrorHandler(err, command));
};

export const releaseReact = (command: cli.IReleaseReactCommand): Promise<void> => {
  let bundleName: string = command.bundleName;
  let entryFile: string = command.entryFile;
  const outputFolder: string = command.outputDir || path.join(os.tmpdir(), "Aether");
  const platform: string = (command.platform = command.platform.toLowerCase());
  const releaseCommand: cli.IReleaseCommand = <any>command;
  // Check for app and deployment exist before releasing an update.
  // This validation helps to save about 1 minute or more in case user has typed wrong app or deployment name.
  return (
    sdk
      .getDeployment(command.appName, command.deploymentName)
      .then((): any => {
        releaseCommand.package = outputFolder;

        switch (platform) {
          case "android":
          case "ios":
            if (!bundleName) {
              bundleName = platform === "ios" ? "main.jsbundle" : `index.${platform}.bundle`;
            }

            break;
          default:
            throw new Error('Platform must be either "android" or "ios".');
        }

        let projectName: string;

        try {
          const projectPackageJson: any = require(path.join(process.cwd(), "package.json"));
          projectName = projectPackageJson.name;
          if (!projectName) {
            throw new Error('The "package.json" file in the CWD does not have the "name" field set.');
          }

          if (!projectPackageJson.dependencies["react-native"]) {
            throw new Error("The project in the CWD is not a React Native project.");
          }
        } catch (error) {
          throw new Error(
            'Unable to find or read "package.json" in the CWD. The "release-react" command must be executed in a React Native project folder.'
          );
        }

        if (!entryFile) {
          entryFile = `index.${platform}.js`;
          if (fileDoesNotExistOrIsDirectory(entryFile)) {
            entryFile = "index.js";
          }

          if (fileDoesNotExistOrIsDirectory(entryFile)) {
            throw new Error(`Entry file "index.${platform}.js" or "index.js" does not exist.`);
          }
        } else {
          if (fileDoesNotExistOrIsDirectory(entryFile)) {
            throw new Error(`Entry file "${entryFile}" does not exist.`);
          }
        }

        const appVersionPromise: Promise<string> = command.appStoreVersion
          ? Promise.resolve(command.appStoreVersion)
          : getReactNativeProjectAppVersion(command, projectName);

        if (command.sourcemapOutput && !command.sourcemapOutput.endsWith(".map")) {
          command.sourcemapOutput = path.join(command.sourcemapOutput, bundleName + ".map");
        }

        return appVersionPromise;
      })
      .then((appVersion: string) => {
        throwForInvalidSemverRange(appVersion);
        releaseCommand.appStoreVersion = appVersion;

        return createEmptyTempReleaseFolder(outputFolder);
      })
      // This is needed to clear the react native bundler cache:
      // https://github.com/facebook/react-native/issues/4289
      .then(() => deleteFolder(`${os.tmpdir()}/react-*`))
      .then(() =>
        runReactNativeBundleCommand(
          bundleName,
          command.development || false,
          entryFile,
          outputFolder,
          platform,
          command.sourcemapOutput
        )
      )
      .then(async () => {
        const isHermesEnabled =
          command.useHermes ||
          (platform === "android" && (await getAndroidHermesEnabled(command.gradleFile))) || // Check if we have to run hermes to compile JS to Byte Code if Hermes is enabled in build.gradle and we're releasing an Android build
          (platform === "ios" && (await getiOSHermesEnabled(command.podFile))); // Check if we have to run hermes to compile JS to Byte Code if Hermes is enabled in Podfile and we're releasing an iOS build

        if (isHermesEnabled) {
          log(chalk.cyan("\nRunning hermes compiler...\n"));
          await runHermesEmitBinaryCommand(
            bundleName,
            outputFolder,
            command.sourcemapOutput,
            command.extraHermesFlags,
            command.gradleFile
          );
        }
      })
      .then(async () => {
        if (command.privateKeyPath) {
          log(chalk.cyan("\nSigning the bundle:\n"));
          await sign(command.privateKeyPath, outputFolder);
        } else {
          console.log("private key was not provided");
        }
      })
      .then(() => {
        log(chalk.cyan("\nReleasing update contents to Aether:\n"));
        return release(releaseCommand);
      })
      .then(() => {
        if (!command.outputDir) {
          deleteFolder(outputFolder);
        }
      })
      .catch((err: Error) => {
        deleteFolder(outputFolder);
        throw err;
      })
  );
};

function rollback(command: cli.IRollbackCommand): Promise<void> {
  return confirm(undefined, command.nonInteractive || !!command.force).then((wasConfirmed: boolean) => {
    if (!wasConfirmed) {
      log("Rollback cancelled.");
      return;
    }

    return sdk.rollback(command.appName, command.deploymentName, command.targetRelease || undefined).then((): void => {
      log(
        'Successfully performed a rollback on the "' + command.deploymentName + '" deployment of the "' + command.appName + '" app.'
      );
    });
  });
}

function promptForLoginCredentials(): Promise<{ email: string; password: string }> {
  return new Promise((resolve, reject) => {
    prompt.message = "";
    prompt.delimiter = "";
    prompt.start();
    prompt.get(
      {
        properties: {
          email: { description: chalk.cyan("Email: ") },
          password: { description: chalk.cyan("Password: "), hidden: true, replace: "*" },
        },
      },
      (err: any, result: any) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({
          email: (result.email || "").toString().trim(),
          password: (result.password || "").toString(),
        });
      }
    );
  });
}

function promptForRegistration(): Promise<{ email: string; name: string; password: string; confirmPassword: string }> {
  return new Promise((resolve, reject) => {
    prompt.message = "";
    prompt.delimiter = "";
    prompt.start();
    prompt.get(
      {
        properties: {
          email: { description: chalk.cyan("Email: ") },
          name: { description: chalk.cyan("Name (optional): "), default: "" },
          password: {
            description: chalk.cyan("Password (min 12 characters): "),
            hidden: true,
            replace: "*",
          },
          confirmPassword: {
            description: chalk.cyan("Confirm password: "),
            hidden: true,
            replace: "*",
          },
        },
      },
      (err: any, result: any) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({
          email: (result.email || "").toString().trim(),
          name: (result.name || "").toString().trim(),
          password: (result.password || "").toString(),
          confirmPassword: (result.confirmPassword || "").toString(),
        });
      }
    );
  });
}

export const runReactNativeBundleCommand = (
  bundleName: string,
  development: boolean,
  entryFile: string,
  outputFolder: string,
  platform: string,
  sourcemapOutput: string
): Promise<void> => {
  const reactNativeBundleArgs: string[] = [];
  const envNodeArgs: string = process.env.CODE_PUSH_NODE_ARGS;

  if (typeof envNodeArgs !== "undefined") {
    Array.prototype.push.apply(reactNativeBundleArgs, envNodeArgs.trim().split(/\s+/));
  }

  const isOldCLI = fs.existsSync(path.join("node_modules", "react-native", "local-cli", "cli.js"));

  Array.prototype.push.apply(reactNativeBundleArgs, [
    isOldCLI ? path.join("node_modules", "react-native", "local-cli", "cli.js") : path.join("node_modules", "react-native", "cli.js"),
    "bundle",
    "--assets-dest",
    outputFolder,
    "--bundle-output",
    path.join(outputFolder, bundleName),
    "--dev",
    development,
    "--entry-file",
    entryFile,
    "--platform",
    platform,
  ]);

  if (sourcemapOutput) {
    reactNativeBundleArgs.push("--sourcemap-output", sourcemapOutput);
  }

  log(chalk.cyan('Running "react-native bundle" command:\n'));
  const reactNativeBundleProcess = spawn("node", reactNativeBundleArgs);
  log(`node ${reactNativeBundleArgs.join(" ")}`);

  return new Promise<void>((resolve, reject) => {
    reactNativeBundleProcess.stdout.on("data", (data: Buffer) => {
      log(data.toString().trim());
    });

    reactNativeBundleProcess.stderr.on("data", (data: Buffer) => {
      console.error(data.toString().trim());
    });

    reactNativeBundleProcess.on("close", (exitCode: number) => {
      if (exitCode) {
        reject(new Error(`"react-native bundle" command exited with code ${exitCode}.`));
      }

      resolve();
    });
  });
};

function serializeConnectionInfo(accessKey: string, preserveAccessKeyOnLogout: boolean, customServerUrl?: string): void {
  const connectionInfo: ILoginConnectionInfo = {
    accessKey: accessKey,
    preserveAccessKeyOnLogout: preserveAccessKeyOnLogout,
  };
  if (customServerUrl) {
    connectionInfo.customServerUrl = customServerUrl;
  }

  fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
  const json: string = JSON.stringify(connectionInfo);
  fs.writeFileSync(configFilePath, json, { encoding: "utf8" });

  log(`Session file written to ${chalk.cyan(configFilePath)}. Run ${chalk.cyan("aether logout")} to terminate the session.`);
}

function sessionList(command: cli.ISessionListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return sdk.getSessions().then((sessions: Session[]): void => {
    printSessions(command.format, sessions);
  });
}

function sessionRemove(command: cli.ISessionRemoveCommand): Promise<void> {
  if (os.hostname() === command.machineName) {
    throw new Error("Cannot remove the current login session via this command. Please run 'aether logout' instead.");
  } else {
    return confirm(undefined, command.nonInteractive || !!command.force).then((wasConfirmed: boolean) => {
      if (wasConfirmed) {
        return sdk.removeSessions(command.machineName).then((): void => {
          log(`Successfully removed the login session for "${command.machineName}".`);
        });
      }

      log("Session removal cancelled.");
    });
  }
}

function releaseErrorHandler(error: AetherError, command: cli.ICommand): void {
  if ((<any>command).noDuplicateReleaseError && error.statusCode === 409) {
    console.warn(chalk.yellow("[Warning] " + error.message));
  } else {
    throw error;
  }
}

function throwForInvalidEmail(email: string): void {
  if (!emailValidator.validate(email)) {
    throw new Error('"' + email + '" is an invalid e-mail address.');
  }
}

function throwForInvalidSemverRange(semverRange: string): void {
  if (semver.validRange(semverRange) === null) {
    throw new Error('Please use a semver-compliant target binary version range, for example "1.0.0", "*" or "^1.2.3".');
  }
}

function throwForInvalidOutputFormat(format: string): void {
  switch (format) {
    case "json":
    case "table":
      break;

    default:
      throw new Error("Invalid format:  " + format + ".");
  }
}

function whoami(command: cli.ICommand): Promise<void> {
  return sdk.getAccountInfo().then((account): void => {
    log(account.email);
  });
}

function isCommandOptionSpecified(option: any): boolean {
  return option !== undefined && option !== null;
}

function getSdk(accessKey: string, headers: Record<string, string>, customServerUrl: string): AccountManager {
  const sdk: any = new AccountManager(accessKey, CLI_HEADERS, customServerUrl);
  /*
   * If the server returns `Unauthorized`, it must be due to an invalid
   * (or expired) access key. For convenience, we patch every SDK call
   * to delete the cached connection so the user can simply
   * login again instead of having to log out first.
   */
  Object.getOwnPropertyNames(AccountManager.prototype).forEach((functionName: any) => {
    if (typeof sdk[functionName] === "function") {
      const originalFunction = sdk[functionName];
      sdk[functionName] = function () {
        let maybePromise: Promise<any> = originalFunction.apply(sdk, arguments);
        if (maybePromise && maybePromise.then !== undefined) {
          maybePromise = maybePromise.catch((error: any) => {
            if (error.statusCode && error.statusCode === 401) {
              deleteConnectionInfoCache(/* printMessage */ false);
            }

            throw error;
          });
        }

        return maybePromise;
      };
    }
  });

  return sdk;
}
