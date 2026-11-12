'use strict';

// Runs the app's operations through Zapier's app tester against a real control plane.
// Needs CRAWLUME_CONTROL_URL, CRAWLUME_PROJECT_ID and CRAWLUME_API_KEY; skipped without them.
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { test } = require('node:test');

const zapier = require('zapier-platform-core');
const App = require('../index');
const { verifyWebhook } = require('../lib/api');

const appTester = zapier.createAppTester(App);
const configured = Boolean(process.env.CRAWLUME_CONTROL_URL && process.env.CRAWLUME_API_KEY);
const authData = {
  baseUrl: process.env.CRAWLUME_CONTROL_URL,
  projectId: process.env.CRAWLUME_PROJECT_ID,
  apiKey: process.env.CRAWLUME_API_KEY,
};
const url = process.env.CRAWLUME_TEST_URL || 'https://www.iana.org/help/example-domains';

test('authentication test accepts the key and rejects a bad one', { skip: !configured }, async () => {
  assert.deepEqual(await appTester(App.authentication.test, { authData }), { projectId: authData.projectId });
  await assert.rejects(appTester(App.authentication.test, { authData: { ...authData, apiKey: 'dya_live_invalid' } }), /invalid/u);
});

test('Read Page returns Markdown, Find Job returns the same result', { skip: !configured }, async () => {
  const page = await appTester(App.creates.read_page.operation.perform, { authData, inputData: { url, cache_mode: 'live' } });
  assert.equal(page.status, 'completed');
  assert.ok(page.markdown.length > 100, 'markdown is present');
  const [found] = await appTester(App.searches.find_job.operation.perform, { authData, inputData: { job_id: page.job_id } });
  assert.equal(found.markdown, page.markdown);
});

test('Start Read Job then Cancel Job; control-plane problems surface their code', { skip: !configured }, async () => {
  const job = await appTester(App.creates.start_read_job.operation.perform, { authData, inputData: { url } });
  assert.ok(['accepted', 'queued', 'assigned', 'running', 'completed'].includes(job.status));
  const after = await appTester(App.creates.cancel_job.operation.perform, { authData, inputData: { job_id: job.id } })
    .catch((error) => error);
  // A fast Worker may finish first, and cancelling a finished Job is a 409 transition conflict.
  if (after instanceof Error) assert.match(after.message, /^JOB_/u);
  else assert.equal(after.status, 'cancelled');
  await assert.rejects(
    appTester(App.creates.start_read_job.operation.perform, { authData, inputData: { url: 'ftp://example.com/' } }),
    /JOB_REQUEST_INVALID/u,
  );
});

test('trigger perform accepts a signed delivery and rejects a forged one', async () => {
  const secret = `whsec_${Buffer.from(randomUUID() + randomUUID()).toString('base64')}`;
  const event = { id: randomUUID(), type: 'job.completed', data: { job_id: randomUUID() } };
  const content = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`msg_1.${timestamp}.${content}`).digest('base64');
  const headers = { 'Http-Webhook-Id': 'msg_1', 'Http-Webhook-Timestamp': timestamp, 'Http-Webhook-Signature': `v1,${signature}` };
  const bundle = { authData, subscribeData: { secret }, cleanedRequest: event, rawRequest: { headers, content } };
  assert.deepEqual(await appTester(App.triggers.job_finished.operation.perform, bundle), [event]);
  await assert.rejects(
    appTester(App.triggers.job_finished.operation.perform, { ...bundle, rawRequest: { headers, content: `${content} ` } }),
    /signature/u,
  );
  assert.equal(verifyWebhook(secret, { 'webhook-id': 'msg_1', 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` }, content), true);
});
