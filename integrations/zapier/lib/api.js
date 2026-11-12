'use strict';

const { createHmac, randomUUID, timingSafeEqual } = require('node:crypto');

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

const baseUrl = (bundle) => String(bundle.authData.baseUrl).replace(/\/+$/u, '');
const projectUrl = (bundle, resource) =>
  `${baseUrl(bundle)}/projects/${encodeURIComponent(bundle.authData.projectId)}${resource}`;

// Only control-plane calls carry the API key; presigned Artifact URLs must go out unauthenticated.
const addApiKey = (request, z, bundle) => {
  if (bundle.authData.apiKey && request.url.startsWith(baseUrl(bundle))) {
    request.headers.authorization = `Bearer ${bundle.authData.apiKey}`;
  }
  return request;
};

// Failures are RFC 7807 problems; surface their code and detail instead of a bare status.
const throwProblem = (response, z) => {
  if (response.status < 400 || response.skipThrowForStatus) return response;
  let problem = null;
  try {
    problem = JSON.parse(response.content);
  } catch {
    // Non-JSON failures fall through to the generic message below.
  }
  if (problem && typeof problem.detail === 'string') {
    const message = `${problem.code}: ${problem.detail}`;
    if (problem.retryable && response.status === 429) throw new z.errors.ThrottledError(message);
    throw new z.errors.Error(message, problem.code, response.status);
  }
  throw new z.errors.Error(`Crawlume returned HTTP ${response.status}`, 'HTTP_ERROR', response.status);
};

const readJobBody = (inputData) => {
  const browserAllowed = Boolean(inputData.browser_allowed);
  const deadlineMs = Number(inputData.deadline_seconds || 120) * 1000;
  const input = { url: inputData.url, browserAllowed };
  if (inputData.cache_mode) input.cacheMode = inputData.cache_mode;
  return {
    type: 'read',
    input,
    data_class: 'public',
    placement: { class: 'public', pinned_worker_id: null },
    required_capabilities: { http: true },
    budget: {
      deadline_ms: deadlineMs,
      max_provider_attempts: 3,
      max_document_bytes: 5000000,
      max_browser_ms: browserAllowed ? deadlineMs : 0,
      max_browser_contexts: browserAllowed ? 1 : 0,
    },
    policy_version: 'crawlume-zapier',
    upload_private_artifact: false,
  };
};

const createReadJob = async (z, bundle) => {
  const response = await z.request({
    method: 'POST',
    url: projectUrl(bundle, '/jobs'),
    headers: { 'idempotency-key': randomUUID() },
    body: readJobBody(bundle.inputData),
  });
  return response.data.job;
};

const getJob = async (z, bundle, jobId) =>
  (await z.request({ url: projectUrl(bundle, `/jobs/${encodeURIComponent(jobId)}`) })).data.job;

const waitForJob = async (z, bundle, jobId, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJob(z, bundle, jobId);
    if (terminalStatuses.has(job.status) || Date.now() + 1000 > deadline) return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

const listPublications = async (z, bundle, jobId) => {
  const publications = [];
  let afterSequence;
  for (;;) {
    const params = { limit: 100 };
    if (afterSequence !== undefined) params.after_sequence = afterSequence;
    const page = (await z.request({
      url: projectUrl(bundle, `/jobs/${encodeURIComponent(jobId)}/publications`),
      params,
    })).data;
    publications.push(...page.publications);
    if (!page.pagination.has_more || page.pagination.next_sequence === null) return publications;
    afterSequence = page.pagination.next_sequence;
  }
};

const downloadArtifact = async (z, bundle, artifact) => {
  if (artifact.storage !== 'cloud_object') return null;
  const download = (await z.request({
    url: projectUrl(bundle, `/artifacts/${encodeURIComponent(artifact.id)}/download`),
  })).data;
  return JSON.parse((await z.request({ url: download.url })).content);
};

/** One flat object per published read result, which is what Zap steps map fields from. */
const readResults = async (z, bundle, job) => {
  const results = [];
  for (const publication of await listPublications(z, bundle, job.id)) {
    const content = await downloadArtifact(z, bundle, publication.artifact);
    const result = content ? content.result : null;
    results.push({
      id: job.id,
      job_id: job.id,
      status: job.status,
      url: job.input.url,
      title: result ? result.title : null,
      markdown: result ? result.contentMarkdown : null,
      completeness: publication.completeness,
      artifact_id: publication.artifact.id,
    });
  }
  return results;
};

// Standard Webhooks verification, matching crawlume/sdk/webhooks.
const verifyWebhook = (secret, headers, body, nowMs = Date.now()) => {
  // Zapier exposes raw request headers with an "Http-" prefix; accept plain names too.
  const header = (name) => {
    const entry = Object.entries(headers || {}).find(([key]) => {
      const lower = key.toLowerCase();
      return lower === name || lower === `http-${name}`;
    });
    return entry ? String(entry[1]) : undefined;
  };
  const id = header('webhook-id');
  const timestamp = header('webhook-timestamp');
  const signatures = header('webhook-signature');
  if (!id || !timestamp || !signatures || !/^[0-9]+$/u.test(timestamp)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > 300) return false;
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) return false;
  const expected = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
    .update(`${id}.${timestamp}.${body}`)
    .digest();
  return signatures.split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => Buffer.from(entry.slice(3), 'base64'))
    .some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected));
};

module.exports = {
  addApiKey,
  createReadJob,
  getJob,
  projectUrl,
  readResults,
  terminalStatuses,
  throwProblem,
  verifyWebhook,
  waitForJob,
};
