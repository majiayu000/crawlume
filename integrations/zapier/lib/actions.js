'use strict';

const { createReadJob, getJob, projectUrl, readResults, verifyWebhook, waitForJob } = require('./api');

const readSample = {
  id: '0aefbb60-6fff-451e-b923-5ab4de5fc804',
  job_id: '0aefbb60-6fff-451e-b923-5ab4de5fc804',
  status: 'completed',
  url: 'https://www.iana.org/help/example-domains',
  title: 'Example Domains',
  markdown: 'A number of domains such as `example.com` and `example.org` are maintained for documentation purposes.',
  completeness: 'complete',
  artifact_id: 'f54c3a16-7106-4e14-899f-e162b059476e',
};

const jobSample = {
  id: '0aefbb60-6fff-451e-b923-5ab4de5fc804',
  type: 'read',
  status: 'queued',
  input: { url: 'https://www.iana.org/help/example-domains', browserAllowed: false },
  result_completeness: null,
  error_code: null,
};

const readFields = [
  { key: 'url', label: 'URL', required: true, type: 'string', helpText: 'Public http(s) page to read.' },
  {
    key: 'cache_mode',
    label: 'Cache Mode',
    required: false,
    choices: { 'prefer-cache': 'Prefer cache', live: 'Live', 'cache-only': 'Cache only' },
  },
  { key: 'browser_allowed', label: 'Allow Browser', required: false, type: 'boolean', default: 'false' },
];

const jobIdField = { key: 'job_id', label: 'Job ID', required: true, type: 'string' };

// Zapier stops an action after 30 seconds, so Read Page waits at most 25 before giving up.
const readPageTimeoutMs = 25000;

const readPage = {
  key: 'read_page',
  noun: 'Page',
  display: {
    label: 'Read Page',
    description: 'Reads a URL through Crawlume and returns its Markdown (up to 25 seconds).',
  },
  operation: {
    inputFields: readFields,
    perform: async (z, bundle) => {
      const job = await createReadJob(z, { ...bundle, inputData: { ...bundle.inputData, deadline_seconds: 25 } });
      const finished = await waitForJob(z, bundle, job.id, readPageTimeoutMs);
      if (finished.status !== 'completed') {
        throw new z.errors.Error(
          `Read Job ${finished.id} is ${finished.status}${finished.error_code ? `: ${finished.error_code}` : ''}. ` +
            'Use Start Read Job and Find Job for slow pages.',
          'JobNotCompleted',
        );
      }
      const [first] = await readResults(z, bundle, finished);
      if (!first || first.markdown === null) {
        throw new z.errors.Error('The Job published no cloud Artifact; enable cloud Artifact storage.', 'NoArtifact');
      }
      return first;
    },
    sample: readSample,
  },
};

const startReadJob = {
  key: 'start_read_job',
  noun: 'Job',
  display: { label: 'Start Read Job', description: 'Queues a read Job and returns it without waiting.' },
  operation: {
    inputFields: readFields,
    perform: (z, bundle) => createReadJob(z, bundle),
    sample: jobSample,
  },
};

const cancelJob = {
  key: 'cancel_job',
  noun: 'Job',
  display: { label: 'Cancel Job', description: 'Cancels a Job that has not finished.' },
  operation: {
    inputFields: [jobIdField],
    perform: async (z, bundle) => (await z.request({
      method: 'POST',
      url: projectUrl(bundle, `/jobs/${encodeURIComponent(bundle.inputData.job_id)}/cancel`),
      body: {},
    })).data.job,
    sample: { ...jobSample, status: 'cancelled' },
  },
};

const findJob = {
  key: 'find_job',
  noun: 'Job',
  display: {
    label: 'Find Job',
    description: 'Finds a Job by ID and, once it has completed, returns its Markdown.',
  },
  operation: {
    inputFields: [jobIdField],
    perform: async (z, bundle) => {
      const job = await getJob(z, bundle, bundle.inputData.job_id);
      if (job.status !== 'completed') {
        return [{ id: job.id, job_id: job.id, status: job.status, url: job.input.url, error_code: job.error_code }];
      }
      return readResults(z, bundle, job);
    },
    sample: readSample,
  },
};

const jobFinishedSample = {
  id: '6a3f1f0e-5a8e-4d58-9f0c-2c7d1f8b9e01',
  type: 'job.completed',
  occurred_at: '2026-11-12T08:53:35.618Z',
  data: {
    job_id: '0aefbb60-6fff-451e-b923-5ab4de5fc804',
    project_id: '20e074b0-2460-4b7c-a970-2dec99c5d6bc',
    status: 'completed',
    result_completeness: 'complete',
    error_code: null,
  },
};

const jobFinished = {
  key: 'job_finished',
  noun: 'Job',
  display: { label: 'Job Finished', description: 'Triggers when a Crawlume Job completes, fails or is cancelled.' },
  operation: {
    type: 'hook',
    inputFields: [
      {
        key: 'event_types',
        label: 'Events',
        required: true,
        list: true,
        choices: { 'job.completed': 'Job completed', 'job.failed': 'Job failed', 'job.cancelled': 'Job cancelled' },
        default: 'job.completed',
      },
    ],
    performSubscribe: async (z, bundle) => {
      const response = await z.request({
        method: 'POST',
        url: projectUrl(bundle, '/webhook-endpoints'),
        body: { url: bundle.targetUrl, event_types: bundle.inputData.event_types },
      });
      return { id: response.data.endpoint.id, secret: response.data.secret };
    },
    performUnsubscribe: async (z, bundle) => {
      await z.request({
        method: 'DELETE',
        url: projectUrl(bundle, `/webhook-endpoints/${encodeURIComponent(bundle.subscribeData.id)}`),
      });
      return {};
    },
    perform: (z, bundle) => {
      const raw = bundle.rawRequest || {};
      if (!verifyWebhook(bundle.subscribeData.secret, raw.headers, raw.content)) {
        throw new z.errors.Error('Webhook signature did not verify.', 'InvalidSignature', 401);
      }
      // Zapier deduplicates on id, which is the Crawlume event id; retried deliveries collapse.
      return [bundle.cleanedRequest];
    },
    // The API has no route that lists past events or Jobs, so the editor gets this fixed sample.
    performList: () => [jobFinishedSample],
    sample: jobFinishedSample,
  },
};

module.exports = { cancelJob, findJob, jobFinished, readPage, startReadJob };
