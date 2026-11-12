// Browser client for the control-plane API. The human Access Token lives in memory only; the
// HttpOnly refresh cookie re-issues it after a reload. Project API keys used for Job and webhook
// routes are kept in sessionStorage for this tab only.

export type Problem = Readonly<{
  status: number;
  code: string;
  title: string;
  detail: string;
  request_id?: string;
  errors?: ReadonlyArray<Readonly<{ field: string; message: string }>>;
}>;

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(`${problem.title}: ${problem.detail}`);
    this.name = "ApiError";
  }
}

export type User = Readonly<{ id: string; email: string | null; display_name: string | null }>;
export type Pagination = Readonly<{ next_cursor: string | null; has_more: boolean; limit: number }>;
export type Organization = Readonly<{
  id: string; slug: string; name: string; kind: "personal" | "business";
  role: "owner" | "admin" | "member"; created_at: string;
}>;
export type Project = Readonly<{
  id: string; organization_id: string; slug: string; name: string; created_at: string;
}>;
export type ApiKeyScope = "tasks:write" | "results:read" | "project:admin";
export type ApiKey = Readonly<{
  id: string; display_prefix: string; scopes: ApiKeyScope[]; created_by_user_id: string;
  created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null;
}>;
export type Job = Readonly<{
  id: string; type: string; input: Record<string, unknown>; status: string; priority: number;
  result_completeness: "complete" | "partial" | null; error_code: string | null;
  not_before: string; deadline_at: string; policy_version: string;
  budget: Record<string, number>;
}>;
export type Publication = Readonly<{
  id: string; sequence: number; completeness: "complete" | "partial"; recorded_at: string;
  artifact: Readonly<{
    id: string; version: number; content_hash: string; byte_count: number; media_type: string;
    storage: "worker_local" | "cloud_object"; created_at: string;
  }>;
}>;
export type WebhookEndpoint = Readonly<{
  id: string; url: string; event_types: string[]; status: "active" | "disabled"; created_at: string;
}>;
export type WebhookDelivery = Readonly<{
  id: string; event_id: string; endpoint_id: string; event_type: string;
  status: "pending" | "succeeded" | "dead_letter"; attempt_count: number; next_attempt_at: string;
  last_status_code: number | null; last_error: string | null; created_at: string;
}>;

const userStorageKey = "crawlume.console.user";
const apiKeyStoragePrefix = "crawlume.console.api-key.";

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let refreshing: Promise<boolean> | null = null;

function storage(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

async function problemFrom(response: Response): Promise<Problem> {
  try {
    const body = await response.json() as Partial<Problem>;
    if (typeof body.code === "string") return { ...body, status: response.status } as Problem;
  } catch {
    // Fall through to a generic problem for non-JSON error bodies.
  }
  return {
    status: response.status,
    code: `HTTP_${response.status}`,
    title: response.statusText || "Request failed",
    detail: `The control plane answered ${response.status}.`,
  };
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) throw new ApiError(await problemFrom(response));
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function acceptToken(body: { access_token: string; access_token_expires_at: string }): void {
  accessToken = body.access_token;
  accessTokenExpiresAt = Date.parse(body.access_token_expires_at);
}

export function currentUser(): User | null {
  const raw = storage("session")?.getItem(userStorageKey);
  return raw ? JSON.parse(raw) as User : null;
}

export async function completeLogin(query: string): Promise<User> {
  const response = await fetch(`/v1/auth/oidc/callback${query}`, { credentials: "same-origin" });
  const body = await parse<{ access_token: string; access_token_expires_at: string; user: User }>(
    response,
  );
  acceptToken(body);
  storage("session")?.setItem(userStorageKey, JSON.stringify(body.user));
  return body.user;
}

async function rotateRefreshCookie(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch("/v1/auth/refresh", { method: "POST", credentials: "same-origin" });
    if (response.ok) {
      acceptToken(await response.json() as { access_token: string; access_token_expires_at: string });
      return true;
    }
    // 409 means another tab rotated the same cookie a moment ago; the new cookie is already set.
    if (response.status !== 409) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

/** Ensures an Access Token is in memory, using the refresh cookie when needed. */
export async function ensureSession(): Promise<boolean> {
  if (accessToken !== null && Date.now() < accessTokenExpiresAt - 30_000) return true;
  refreshing ??= rotateRefreshCookie().finally(() => { refreshing = null; });
  const ok = await refreshing;
  if (!ok) {
    accessToken = null;
    storage("session")?.removeItem(userStorageKey);
  }
  return ok;
}

export async function logout(): Promise<void> {
  if (accessToken !== null) {
    await fetch("/v1/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
      credentials: "same-origin",
    });
  }
  accessToken = null;
  storage("session")?.clear();
}

function jsonInit(method: string, token: string, body: unknown, headers: Record<string, string>) {
  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** Calls a HumanAccessToken route (organizations, projects, API keys). */
export async function human<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  if (!await ensureSession()) {
    throw new ApiError({ status: 401, code: "SESSION_EXPIRED", title: "Signed out",
      detail: "Sign in again to continue." });
  }
  return parse<T>(await fetch(`/v1${path}`, jsonInit(method, accessToken!, body, headers)));
}

export function projectApiKey(projectId: string): string | null {
  return storage("session")?.getItem(apiKeyStoragePrefix + projectId) ?? null;
}

export function setProjectApiKey(projectId: string, secret: string | null): void {
  if (secret === null) storage("session")?.removeItem(apiKeyStoragePrefix + projectId);
  else storage("session")?.setItem(apiKeyStoragePrefix + projectId, secret);
}

/** Calls a ProjectApiKey route (Jobs, publications, artifacts, webhooks) with this tab's key. */
export async function project<T>(
  projectId: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const key = projectApiKey(projectId);
  if (key === null) {
    throw new ApiError({ status: 401, code: "API_KEY_MISSING", title: "No API key",
      detail: "Paste a Project API key for this tab first." });
  }
  return parse<T>(await fetch(`/v1/projects/${projectId}${path}`, jsonInit(method, key, body, headers)));
}

const recentJobsPrefix = "crawlume.console.jobs.";

/** Job IDs this browser created or opened; the API has no Job listing route yet. */
export function recentJobs(projectId: string): string[] {
  const raw = storage("local")?.getItem(recentJobsPrefix + projectId);
  return raw ? JSON.parse(raw) as string[] : [];
}

export function rememberJob(projectId: string, jobId: string): void {
  const jobs = [jobId, ...recentJobs(projectId).filter((id) => id !== jobId)].slice(0, 50);
  storage("local")?.setItem(recentJobsPrefix + projectId, JSON.stringify(jobs));
}

export function forgetJob(projectId: string, jobId: string): void {
  const jobs = recentJobs(projectId).filter((id) => id !== jobId);
  storage("local")?.setItem(recentJobsPrefix + projectId, JSON.stringify(jobs));
}

/** Collects every page of a cursor-paginated human route. */
export async function allPages<T>(path: string, field: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? "?limit=100" : `?limit=100&cursor=${encodeURIComponent(cursor)}`;
    const page = await human<Record<string, unknown> & { pagination: Pagination }>("GET", path + query);
    items.push(...page[field] as T[]);
    cursor = page.pagination.has_more ? page.pagination.next_cursor : null;
  } while (cursor !== null);
  return items;
}
