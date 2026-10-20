// Per-tab model that holds tab-only fields and CTE query views. The import API recreates these empty,
// so their YAML is copied separately after import (see jobs/queryModels.ts).
export interface OmniQueryModel {
  id: string;
  connection_id?: string;
  base_model_id?: string;
  environment_connection_id?: string | null;
  model_kind?: string;
  views?: unknown[];
  [key: string]: unknown;
}

export interface OmniWorkbookModel {
  id: string;
  connection_id?: string;
  base_model_id?: string;
  environment_connection_id?: string | null;
  [key: string]: unknown;
}

export interface OmniExportPayload {
  exportVersion?: string;
  document?: { name?: string; ephemeral?: string };
  dashboard?: unknown;
  workbookModel?: OmniWorkbookModel;
  queryModels?: Record<string, OmniQueryModel>;
  fileUploads?: Record<string, unknown>;
  baseModelId?: string;
  identifier?: string;
  [key: string]: unknown;
}

// Tabs or controls keyed by id, plus their display order.
export interface OmniKeyedSection {
  data?: Record<string, unknown>;
  order?: string[];
}

// GET /api/v2/documents/{id} response. The same shape is accepted as a PATCH draft body
// (minus the read-only `app` / `draftOf`).
export interface OmniDocState {
  name: string;
  description: string | null;
  modelId?: string;
  workbookModelId?: string;
  queryPresentations?: OmniKeyedSection;
  controls?: OmniKeyedSection;
  settings?: Record<string, unknown>;
  containers?: unknown[];
  [key: string]: unknown;
}

export interface OmniDraftPatch {
  modelId?: string;
  workbookModelId?: string;
  name?: string;
  description?: string | null;
  summary?: string;
  queryPresentations?: OmniKeyedSection;
  controls?: OmniKeyedSection;
  settings?: Record<string, unknown>;
  containers?: unknown[];
}

export interface OmniImportResponse {
  documentId: string;
  identifier: string;
  // Source query-presentation miniUuid → imported miniUuid. Used to pair each source tile with its imported tile.
  miniUuidMap: Record<string, string>;
}

export interface OmniModelYaml {
  files: Record<string, string>;
  checksums?: Record<string, string>;
}

export interface OmniModelRecord {
  id: string;
  connectionId: string;
  modelKind?: string;
  name?: string;
  baseModelId?: string | null;
  [key: string]: unknown;
}

export interface OmniDocumentRecord {
  identifier: string;
  name: string;
  folderId?: string;
  type?: string;
  updatedAt?: string;
  description?: string | null;
  labels?: string[];
  [key: string]: unknown;
}

export interface OmniLabelRecord {
  name: string;
  color?: string | null;
  description?: string | null;
  isVerified?: boolean;
  isHomepageSection?: boolean;
}

export interface OmniLabelsListResponse {
  labels: OmniLabelRecord[];
}

export interface OmniPageInfo {
  nextCursor?: string | null;
  hasNextPage?: boolean;
}

export interface OmniListResponse {
  pageInfo: OmniPageInfo;
  records: OmniDocumentRecord[];
}

export interface OmniConnection {
  id: string;
  name: string;
  dialect: string;
  database: string;
  baseRole?: string;
  deletedAt?: string | null;
  defaultSchema?: string;
  [key: string]: unknown;
}

export interface OmniSchemaModel {
  id: string;
  connectionId: string;
  modelKind: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  [key: string]: unknown;
}

export interface ScimUserGroup {
  display: string;
  value: string;
}

export interface ScimUser {
  id: string;
  displayName: string;
  active: boolean;
  userName: string;
  embedEmail: string | null;
  embedEntity: string;
  embedExternalId: string;
  emails: Array<{ primary: boolean; value: string }>;
  groups: ScimUserGroup[];
  meta: { created: string; lastModified: string; resourceType: string };
  'urn:omni:params:scim:schemas:extension:user:2.0'?: { lastLogin?: string | null };
}

export interface ScimListResponse {
  Resources: ScimUser[];
  itemsPerPage: number;
  startIndex: number;
  totalResults: number;
}
