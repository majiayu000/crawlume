import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INodeCredentialTestResult,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

type ApiContext = IExecuteFunctions | IHookFunctions;

export const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

/**
 * No API-key route lists Jobs, so probe a Job that cannot exist: 404 proves the key is valid for this
 * Project, while 401/403 mean a bad key or a key bound to another Project.
 */
export async function crawlumeApiTest(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
	const data = credential.data ?? {};
	const baseUrl = String(data.baseUrl ?? '').replace(/\/+$/u, '');
	const projectId = encodeURIComponent(String(data.projectId ?? ''));
	try {
		// ICredentialTestFunctions only exposes the legacy request helper.
		// eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions
		const response = (await this.helpers.request({
			method: 'GET',
			uri: `${baseUrl}/projects/${projectId}/jobs/00000000-0000-4000-8000-000000000000`,
			headers: { authorization: `Bearer ${String(data.apiKey ?? '')}` },
			json: true,
			simple: false,
			resolveWithFullResponse: true,
		})) as { statusCode: number; body?: IDataObject };
		if (response.statusCode === 404) return { status: 'OK', message: 'Connection successful' };
		return { status: 'Error', message: String(response.body?.detail ?? `HTTP ${response.statusCode}`) };
	} catch (error) {
		return { status: 'Error', message: (error as Error).message };
	}
}

export async function projectPath(context: ApiContext): Promise<{ baseUrl: string; path: string }> {
	const credentials = await context.getCredentials('crawlumeApi');
	const baseUrl = String(credentials.baseUrl).replace(/\/+$/u, '');
	return { baseUrl, path: `/projects/${encodeURIComponent(String(credentials.projectId))}` };
}

/** Calls the Project Control API. GETs carry no body or content-type, which the API rejects. */
export async function crawlumeRequest(
	context: ApiContext,
	method: IHttpRequestMethods,
	resource: string,
	options: { body?: IDataObject; qs?: IDataObject; idempotencyKey?: string } = {},
): Promise<IDataObject> {
	const { baseUrl, path } = await projectPath(context);
	const request: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${path}${resource}`,
		qs: options.qs,
		json: true,
		headers: {},
	};
	if (options.body !== undefined) {
		request.body = options.body;
		request.headers!['content-type'] = 'application/json';
	}
	if (options.idempotencyKey !== undefined) request.headers!['idempotency-key'] = options.idempotencyKey;
	try {
		return (await context.helpers.httpRequestWithAuthentication.call(context, 'crawlumeApi', request)) as IDataObject;
	} catch (error) {
		// Failures are RFC 7807 problems; lead with their code and detail instead of n8n's generic text.
		// n8n already wraps HTTP failures in a NodeApiError that keeps the response body in context.data.
		type Problem = { code?: unknown; detail?: unknown };
		const failure = error as { context?: { data?: Problem }; response?: { data?: Problem } };
		const problem = failure.context?.data ?? failure.response?.data;
		const message = typeof problem?.detail === 'string' ? `${String(problem.code)}: ${problem.detail}` : undefined;
		const httpCode = (error as { httpCode?: string }).httpCode;
		throw new NodeApiError(context.getNode(), (problem ?? error) as JsonObject, {
			...(message === undefined ? {} : { message }),
			...(httpCode === undefined ? {} : { httpCode }),
		});
	}
}

export type ReadInput = {
	url: string;
	cacheMode?: string;
	maxAgeSeconds?: number;
	browserAllowed?: boolean;
	deadlineSeconds?: number;
	maxProviderAttempts?: number;
	maxDocumentBytes?: number;
};

/** Builds the read Job body the control plane accepts today (public data, public placement). */
export function readJobBody(input: ReadInput): IDataObject {
	const jobInput: IDataObject = { url: input.url, browserAllowed: input.browserAllowed ?? false };
	if (input.cacheMode) jobInput.cacheMode = input.cacheMode;
	if (input.maxAgeSeconds) jobInput.maxAgeSeconds = input.maxAgeSeconds;
	const deadlineMs = (input.deadlineSeconds ?? 120) * 1_000;
	return {
		type: 'read',
		input: jobInput,
		data_class: 'public',
		placement: { class: 'public', pinned_worker_id: null },
		required_capabilities: { http: true },
		budget: {
			deadline_ms: deadlineMs,
			max_provider_attempts: input.maxProviderAttempts ?? 3,
			max_document_bytes: input.maxDocumentBytes ?? 5_000_000,
			max_browser_ms: input.browserAllowed ? deadlineMs : 0,
			max_browser_contexts: input.browserAllowed ? 1 : 0,
		},
		policy_version: 'n8n-nodes-crawlume',
		upload_private_artifact: false,
	};
}

export async function createReadJob(context: IExecuteFunctions, input: ReadInput): Promise<IDataObject> {
	const response = await crawlumeRequest(context, 'POST', '/jobs', {
		body: readJobBody(input),
		idempotencyKey: randomUUID(),
	});
	return response.job as IDataObject;
}

export async function waitForJob(
	context: IExecuteFunctions,
	jobId: string,
	timeoutMs: number,
	intervalMs = 1_000,
): Promise<IDataObject> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const job = (await crawlumeRequest(context, 'GET', `/jobs/${encodeURIComponent(jobId)}`)).job as IDataObject;
		if (terminalStatuses.has(String(job.status))) return job;
		if (Date.now() + intervalMs > deadline) {
			throw new Error(`Job ${jobId} is still ${String(job.status)} after ${timeoutMs} ms.`);
		}
		await sleep(intervalMs);
	}
}

export async function listPublications(context: IExecuteFunctions, jobId: string): Promise<IDataObject[]> {
	const publications: IDataObject[] = [];
	let afterSequence: number | undefined;
	for (;;) {
		const qs: IDataObject = { limit: 100 };
		if (afterSequence !== undefined) qs.after_sequence = afterSequence;
		const page = await crawlumeRequest(context, 'GET', `/jobs/${encodeURIComponent(jobId)}/publications`, { qs });
		publications.push(...(page.publications as IDataObject[]));
		const pagination = page.pagination as IDataObject;
		if (!pagination.has_more || pagination.next_sequence === null) return publications;
		afterSequence = Number(pagination.next_sequence);
	}
}

/** Downloads a cloud Artifact through its presigned URL; worker-local Artifacts are not reachable. */
export async function downloadArtifact(context: IExecuteFunctions, artifact: IDataObject): Promise<IDataObject | null> {
	if (artifact.storage !== 'cloud_object') return null;
	const download = await crawlumeRequest(context, 'GET', `/artifacts/${encodeURIComponent(String(artifact.id))}/download`);
	const text = (await context.helpers.httpRequest({
		method: 'GET',
		url: String(download.url),
		encoding: 'text',
		json: false,
	})) as string;
	return JSON.parse(text) as IDataObject;
}

/** Flattens a read-result Artifact into the fields most workflows use, keeping the full result. */
export function readOutput(job: IDataObject, publication: IDataObject, content: IDataObject | null): IDataObject {
	const result = (content?.result ?? null) as IDataObject | null;
	return {
		job_id: job.id,
		status: job.status,
		url: (job.input as IDataObject).url,
		title: result?.title ?? null,
		markdown: result?.contentMarkdown ?? null,
		completeness: publication.completeness,
		artifact: publication.artifact,
		result,
	};
}

// Signatures follow the Standard Webhooks scheme used by crawlume/sdk/webhooks:
// HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{body}" with a "whsec_" base64 secret.
export function verifyWebhookSignature(options: {
	secrets: string[];
	headers: Record<string, string | string[] | undefined>;
	body: string;
	toleranceSeconds?: number;
	nowMs?: number;
}): string | null {
	const header = (name: string): string | undefined => {
		const value = options.headers[name];
		return Array.isArray(value) ? value[0] : value;
	};
	const id = header('webhook-id');
	const timestamp = header('webhook-timestamp');
	const signatures = header('webhook-signature');
	if (!id || !timestamp || !signatures) return 'Missing webhook-id, webhook-timestamp or webhook-signature header.';
	if (!/^[0-9]+$/u.test(timestamp)) return 'Invalid webhook-timestamp header.';
	const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
	if (Math.abs(nowSeconds - Number(timestamp)) > (options.toleranceSeconds ?? 300)) {
		return 'Webhook timestamp is outside the tolerance window.';
	}
	const provided = signatures
		.split(' ')
		.filter((entry) => entry.startsWith('v1,'))
		.map((entry) => Buffer.from(entry.slice(3), 'base64'));
	const matched = options.secrets.some((secret) => {
		if (!secret.startsWith('whsec_')) return false;
		const expected = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
			.update(`${id}.${timestamp}.${options.body}`)
			.digest();
		return provided.some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected));
	});
	return matched ? null : 'No webhook signature matched.';
}
