import * as fs from "fs";
import * as path from "path";
import * as yazl from "yazl";

import {
  AccessKey,
  AccessKeyRequest,
  AccessKeyWithSecret,
  Account,
  ApiKey,
  ApiKeyCreationRequest,
  ApiKeyRevokeResult,
  ApiKeyUpdateRequest,
  ApiKeyWithSecret,
  App,
  CollaboratorMap,
  CustomHeaders,
  Deployment,
  DeploymentMetrics,
  Package,
  PackageInfo,
  Session,
} from "./types";
import { AetherError } from "./errors";

const packageJson = require("../../package.json");

const SDK_USER_AGENT = `aether-management-sdk/${packageJson.version}`;
const DEFAULT_SERVER_URL = "http://localhost:3000";
const GATEWAY_TIMEOUT = 504;
const INTERNAL_SERVER_ERROR = 500;

interface JsonResponse {
  headers: Record<string, string>;
  body?: any;
}

interface PackageFile {
  isTemporary: boolean;
  path: string;
}

function urlEncode(strings: TemplateStringsArray, ...values: any[]): string {
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      result += encodeURIComponent(String(values[i]));
    }
  }
  return result;
}

class AccountManager {
  public static AppPermission = {
    OWNER: "Owner",
    COLLABORATOR: "Collaborator",
  };

  public static AetherError = AetherError;

  private _accessKey: string;
  private _serverUrl: string;
  private _customHeaders?: CustomHeaders;

  constructor(accessKey: string, customHeaders?: CustomHeaders, serverUrl?: string) {
    if (!accessKey) {
      throw new Error("An access key must be specified.");
    }
    this._accessKey = accessKey;
    this._customHeaders = customHeaders;
    this._serverUrl = serverUrl || DEFAULT_SERVER_URL;
  }

  public get accessKey(): string {
    return this._accessKey;
  }

  public async isAuthenticated(throwIfUnauthorized?: boolean): Promise<boolean> {
    try {
      const res = await this.requestRaw("GET", "/v1/authenticated");
      return res.status === 200;
    } catch (err) {
      if (err instanceof AetherError && err.statusCode === 401 && !throwIfUnauthorized) {
        return false;
      }
      throw err;
    }
  }

  public async addAccessKey(friendlyName: string, ttl?: number): Promise<AccessKeyWithSecret> {
    if (!friendlyName) {
      throw new Error("A name must be specified when adding an access key.");
    }
    const body: AccessKeyRequest = { friendlyName };
    if (ttl !== undefined) body.ttl = ttl;
    const res = await this.request("POST", "/v1/access-keys", body, true);
    return res.body.accessKey;
  }

  public async getAccessKey(name: string): Promise<AccessKey> {
    const res = await this.request("GET", urlEncode`/v1/access-keys/${name}`, undefined, true);
    return res.body.accessKey;
  }

  public async getAccessKeys(): Promise<AccessKey[]> {
    const res = await this.request("GET", "/v1/access-keys", undefined, true);
    return (res.body.accessKeys as Array<AccessKey & { isSession?: boolean }>).filter((k) => !k.isSession);
  }

  public async getSessions(): Promise<Session[]> {
    const res = await this.request("GET", "/v1/access-keys", undefined, true);
    const sessionMap: Record<string, Session> = {};
    const now = Date.now();
    for (const k of res.body.accessKeys as Array<AccessKey & { isSession?: boolean }>) {
      if (k.isSession && k.createdBy && k.createdTime !== undefined && k.expires > now) {
        sessionMap[k.createdBy] = {
          loggedInTime: k.createdTime,
          createdBy: k.createdBy,
        };
      }
    }
    return Object.values(sessionMap);
  }

  public async patchAccessKey(oldName: string, newName?: string, ttl?: number): Promise<AccessKey> {
    const body: AccessKeyRequest = {};
    if (newName !== undefined) body.friendlyName = newName;
    if (ttl !== undefined) body.ttl = ttl;
    const res = await this.request("PATCH", urlEncode`/v1/access-keys/${oldName}`, body, true);
    return res.body.accessKey;
  }

  public async removeAccessKey(name: string): Promise<void> {
    await this.request("DELETE", urlEncode`/v1/access-keys/${name}`, undefined, false);
  }

  public async removeSessions(createdBy: string): Promise<void> {
    await this.request("DELETE", urlEncode`/v1/sessions/${createdBy}`, undefined, false);
  }

  public async getAccountInfo(): Promise<Account> {
    const res = await this.request("GET", "/v1/account", undefined, true);
    return res.body.account;
  }

  public async getApps(): Promise<App[]> {
    const res = await this.request("GET", "/v1/apps", undefined, true);
    return res.body.apps;
  }

  public async getApp(appName: string): Promise<App> {
    const res = await this.request("GET", urlEncode`/v1/apps/${appName}`, undefined, true);
    return res.body.app;
  }

  public async addApp(appName: string, manuallyProvisionDeployments?: boolean): Promise<App> {
    const body: { name: string; manuallyProvisionDeployments?: boolean } = { name: appName };
    if (manuallyProvisionDeployments !== undefined) {
      body.manuallyProvisionDeployments = manuallyProvisionDeployments;
    }
    const res = await this.request("POST", "/v1/apps", body, true);
    return res.body.app;
  }

  public async removeApp(appName: string): Promise<void> {
    await this.request("DELETE", urlEncode`/v1/apps/${appName}`, undefined, false);
  }

  public async renameApp(oldAppName: string, newAppName: string): Promise<void> {
    await this.request("PATCH", urlEncode`/v1/apps/${oldAppName}`, { name: newAppName }, false);
  }

  public async transferApp(appName: string, email: string): Promise<void> {
    await this.request("POST", urlEncode`/v1/apps/${appName}/transfers`, { email }, false);
  }

  public async getCollaborators(appName: string): Promise<CollaboratorMap> {
    const res = await this.request("GET", urlEncode`/v1/apps/${appName}/collaborators`, undefined, true);
    return res.body.collaborators;
  }

  public async addCollaborator(appName: string, email: string): Promise<void> {
    await this.request("POST", urlEncode`/v1/apps/${appName}/collaborators`, { email }, false);
  }

  public async removeCollaborator(appName: string, email: string): Promise<void> {
    await this.request("DELETE", urlEncode`/v1/apps/${appName}/collaborators/${email}`, undefined, false);
  }

  public async addDeployment(appName: string, deploymentName: string, deploymentKey?: string): Promise<Deployment> {
    const body: { name: string; key?: string } = { name: deploymentName };
    if (deploymentKey) body.key = deploymentKey;
    const res = await this.request("POST", urlEncode`/v1/apps/${appName}/deployments`, body, true);
    return res.body.deployment;
  }

  public async clearDeploymentHistory(appName: string, deploymentName: string): Promise<void> {
    await this.request("DELETE", urlEncode`/v1/apps/${appName}/deployments/${deploymentName}/history`, undefined, false);
  }

  public async getDeployments(appName: string): Promise<Deployment[]> {
    const res = await this.request("GET", urlEncode`/v1/apps/${appName}/deployments`, undefined, true);
    return res.body.deployments;
  }

  public async getDeployment(appName: string, deploymentName: string): Promise<Deployment> {
    const res = await this.request("GET", urlEncode`/v1/apps/${appName}/deployments/${deploymentName}`, undefined, true);
    return res.body.deployment;
  }

  public async renameDeployment(appName: string, oldDeploymentName: string, newDeploymentName: string): Promise<void> {
    await this.request("PATCH", urlEncode`/v1/apps/${appName}/deployments/${oldDeploymentName}`, { name: newDeploymentName }, false);
  }

  public async removeDeployment(appName: string, deploymentName: string): Promise<void> {
    await this.request("DELETE", urlEncode`/v1/apps/${appName}/deployments/${deploymentName}`, undefined, false);
  }

  public async getDeploymentMetrics(appName: string, deploymentName: string): Promise<DeploymentMetrics> {
    const res = await this.request("GET", urlEncode`/v1/apps/${appName}/deployments/${deploymentName}/metrics`, undefined, true);
    return res.body.metrics;
  }

  public async getDeploymentHistory(appName: string, deploymentName: string): Promise<Package[]> {
    const res = await this.request("GET", urlEncode`/v1/apps/${appName}/deployments/${deploymentName}/history`, undefined, true);
    return res.body.history;
  }

  public async release(
    appName: string,
    deploymentName: string,
    filePath: string,
    targetBinaryVersion: string,
    updateMetadata: PackageInfo
  ): Promise<Package> {
    const metadata: PackageInfo = { ...updateMetadata, appVersion: targetBinaryVersion };
    const packageFile = await this.packageFileFromPath(filePath);
    try {
      const url = this._serverUrl + urlEncode`/v1/apps/${appName}/deployments/${deploymentName}/release`;
      const blob = await fs.openAsBlob(packageFile.path);
      const form = new FormData();
      form.append("package", blob, path.basename(packageFile.path));
      form.append("packageInfo", JSON.stringify(metadata));

      const headers = this.buildHeaders(false);
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers, body: form });
      } catch (err) {
        throw this.networkError(err);
      }
      const parsed = await this.parseResponse(res, true);
      return parsed.body.package;
    } finally {
      if (packageFile.isTemporary) {
        try {
          await fs.promises.unlink(packageFile.path);
        } catch {
          /* swallow */
        }
      }
    }
  }

  public async patchRelease(appName: string, deploymentName: string, label: string, updateMetadata: PackageInfo): Promise<void> {
    const body = { packageInfo: { ...updateMetadata, label } };
    await this.request("PATCH", urlEncode`/v1/apps/${appName}/deployments/${deploymentName}/release`, body, false);
  }

  public async promote(
    appName: string,
    sourceDeploymentName: string,
    destinationDeploymentName: string,
    updateMetadata?: PackageInfo
  ): Promise<Package> {
    const body: { destination: string; packageInfo?: PackageInfo } = {
      destination: destinationDeploymentName,
    };
    if (updateMetadata) body.packageInfo = updateMetadata;
    const res = await this.request("POST", urlEncode`/v1/apps/${appName}/deployments/${sourceDeploymentName}/promotions`, body, true);
    return res.body.package;
  }

  public async rollback(appName: string, deploymentName: string, targetRelease?: string): Promise<Package> {
    const body: { targetRelease?: string } = {};
    if (targetRelease) body.targetRelease = targetRelease;
    const res = await this.request("POST", urlEncode`/v1/apps/${appName}/deployments/${deploymentName}/rollbacks`, body, true);
    return res.body.package;
  }

  public async getApiKeys(includeRevoked?: boolean): Promise<ApiKey[]> {
    const qs = includeRevoked ? "?include_revoked=true" : "";
    const res = await this.request("GET", `/v1/api-keys${qs}`, undefined, true);
    return res.body.api_keys;
  }

  public async addApiKey(request: ApiKeyCreationRequest): Promise<ApiKeyWithSecret> {
    const res = await this.request("POST", "/v1/api-keys", request, true);
    return res.body;
  }

  public async patchApiKey(id: string, updates: ApiKeyUpdateRequest): Promise<ApiKey> {
    const res = await this.request("PATCH", urlEncode`/v1/api-keys/${id}`, updates, true);
    return res.body;
  }

  public async revokeApiKey(id: string): Promise<ApiKeyRevokeResult> {
    const res = await this.request("DELETE", urlEncode`/v1/api-keys/${id}`, undefined, true);
    return res.body;
  }

  private buildHeaders(includeContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this._accessKey}`,
      "User-Agent": SDK_USER_AGENT,
    };
    if (this._customHeaders) {
      for (const k of Object.keys(this._customHeaders)) {
        headers[k] = this._customHeaders[k];
      }
    }
    if (includeContentType) {
      headers["Content-Type"] = "application/json;charset=UTF-8";
    }
    return headers;
  }

  private async requestRaw(method: string, endpoint: string): Promise<Response> {
    const url = this._serverUrl + endpoint;
    const headers = this.buildHeaders(false);
    try {
      return await fetch(url, { method, headers });
    } catch (err) {
      throw this.networkError(err);
    }
  }

  private async request(method: string, endpoint: string, body: unknown, expectResponseBody: boolean): Promise<JsonResponse> {
    const url = this._serverUrl + endpoint;
    const hasBody = body !== undefined && body !== null;
    const headers = this.buildHeaders(hasBody);
    const init: RequestInit = { method, headers };
    if (hasBody) {
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw this.networkError(err);
    }
    return this.parseResponse(res, expectResponseBody);
  }

  private async parseResponse(res: Response, expectResponseBody: boolean): Promise<JsonResponse> {
    const text = await res.text();
    let parsed: any;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not JSON */
      }
    }

    const requestId = res.headers.get("x-request-id") || (parsed && parsed.requestId) || undefined;

    if (res.ok) {
      if (expectResponseBody && parsed === undefined) {
        throw new AetherError(`Could not parse response: ${text}`, INTERNAL_SERVER_ERROR, requestId);
      }
      return { headers: this.headersToObject(res.headers), body: parsed };
    }

    const message = (parsed && (parsed.error || parsed.message)) || text || res.statusText || "Request failed";
    throw new AetherError(message, res.status, requestId);
  }

  private headersToObject(h: Headers): Record<string, string> {
    const obj: Record<string, string> = {};
    h.forEach((value, key) => {
      obj[key] = value;
    });
    return obj;
  }

  private networkError(err: unknown): AetherError {
    const message =
      err instanceof Error
        ? `Unable to connect to the Aether server. Are you offline, or behind a firewall or proxy?\n(${err.message})`
        : "Unable to connect to the Aether server.";
    return new AetherError(message, GATEWAY_TIMEOUT);
  }

  private async packageFileFromPath(filePath: string): Promise<PackageFile> {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isDirectory()) {
      return { isTemporary: false, path: filePath };
    }

    const baseDirectoryPath = path.dirname(filePath);
    const fileName = this.generateRandomFilename(15) + ".zip";
    const outPath = path.join(process.cwd(), fileName);
    const files = await this.walkDirectory(filePath);

    return new Promise<PackageFile>((resolve, reject) => {
      const zipFile = new yazl.ZipFile();
      const writeStream = fs.createWriteStream(outPath);

      zipFile.outputStream
        .pipe(writeStream)
        .on("error", reject)
        .on("close", () => resolve({ isTemporary: true, path: outPath }));

      for (const file of files) {
        const relativePath = path.relative(baseDirectoryPath, file).split(path.sep).join("/");
        zipFile.addFile(file, relativePath);
      }
      zipFile.end();
    });
  }

  private async walkDirectory(dir: string): Promise<string[]> {
    const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        const parent = (entry as any).parentPath ?? (entry as any).path ?? dir;
        out.push(path.join(parent, entry.name));
      }
    }
    return out;
  }

  private generateRandomFilename(length: number): string {
    const validChar = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let filename = "";
    for (let i = 0; i < length; i++) {
      filename += validChar.charAt(Math.floor(Math.random() * validChar.length));
    }
    return filename;
  }
}

export = AccountManager;
