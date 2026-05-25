export interface CustomHeaders {
  [headerName: string]: string;
}

export interface Account {
  email: string;
  name: string;
  linkedProviders: string[];
}

export interface AccessKey {
  friendlyName: string;
  createdBy?: string;
  createdTime?: number;
  expires: number;
  isSession?: boolean;
}

export interface AccessKeyWithSecret extends AccessKey {
  name: string;
}

export interface AccessKeyRequest {
  friendlyName?: string;
  ttl?: number;
}

export interface Session {
  loggedInTime: number;
  createdBy: string;
}

export interface CollaboratorProperties {
  permission: "Owner" | "Collaborator";
  isCurrentAccount?: boolean;
}

export interface CollaboratorMap {
  [email: string]: CollaboratorProperties;
}

export interface App {
  name: string;
  collaborators?: CollaboratorMap;
  deployments?: string[];
}

export interface AppCreationRequest {
  name: string;
  manuallyProvisionDeployments?: boolean;
}

export interface Deployment {
  name: string;
  key?: string;
  package?: Package;
}

export interface BlobInfo {
  size: number;
  url: string;
}

export interface PackageHashToBlobInfoMap {
  [packageHash: string]: BlobInfo;
}

export interface PackageInfo {
  appVersion?: string;
  description?: string;
  isDisabled?: boolean;
  isMandatory?: boolean;
  label?: string;
  packageHash?: string;
  rollout?: number;
}

export interface Package extends PackageInfo {
  blobUrl: string;
  diffPackageMap?: PackageHashToBlobInfoMap;
  manifestBlobUrl?: string;
  originalDeployment?: string;
  originalLabel?: string;
  releasedBy?: string;
  releaseMethod?: "Upload" | "Promote" | "Rollback";
  size: number;
  uploadTime: number;
}

export interface UpdateMetrics {
  active: number;
  downloaded?: number;
  failed?: number;
  installed?: number;
}

export interface DeploymentMetrics {
  [packageLabelOrAppVersion: string]: UpdateMetrics;
}

export type ApiKeyScope = "deploy" | "apps" | "keys" | "read";

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyWithSecret extends ApiKey {
  key: string;
}

export interface ApiKeyCreationRequest {
  name: string;
  scopes: ApiKeyScope[];
  expires_at?: string | null;
}

export interface ApiKeyUpdateRequest {
  name?: string;
  scopes?: ApiKeyScope[];
  expires_at?: string | null;
}

export interface ApiKeyRevokeResult {
  id: string;
  revoked_at: string;
}
