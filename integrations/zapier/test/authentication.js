'use strict';

// Checks the connection test against the control plane's 404 bodies; needs no control plane.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const authentication = require('../lib/authentication');

const projectId = '22222222-2222-4222-8222-222222222222';
class ZapierError extends Error {}
const connectionTest = (status, content, authData = {}) => {
  const requests = [];
  const z = {
    request: async (options) => {
      requests.push(options.url);
      return { status, content };
    },
    errors: { Error: ZapierError },
  };
  const bundle = { authData: { baseUrl: 'https://control.example/v1/', projectId, apiKey: 'dya_live_key', ...authData } };
  return { requests, result: authentication.test(z, bundle) };
};

test('accepts the 404 for a missing Job, which only an authenticated key reaches', async () => {
  const { requests, result } = connectionTest(404, JSON.stringify({ code: 'JOB_NOT_FOUND', detail: 'The Job does not exist in this project.' }));
  assert.deepEqual(await result, { projectId });
  assert.deepEqual(requests, [`https://control.example/v1/projects/${projectId}/jobs/00000000-0000-4000-8000-000000000000`]);
});

test('rejects a 404 from routing, which is returned before the key is checked', async () => {
  const route = JSON.stringify({ code: 'PROJECT_ROUTE_NOT_FOUND', detail: 'The Project API route does not exist.' });
  await assert.rejects(
    connectionTest(404, route, { projectId: 'my-project' }).result,
    (error) => error instanceof ZapierError && /^The Project API route does not exist\. .*\/v1.*UUID/u.test(error.message),
  );
  const worker = JSON.stringify({ code: 'WORKER_ROUTE_NOT_FOUND', detail: 'The Worker API route does not exist.' });
  await assert.rejects(connectionTest(404, worker).result, ZapierError);
  await assert.rejects(
    connectionTest(404, '<html>Not Found</html>').result,
    (error) => error instanceof ZapierError && /^HTTP 404 /u.test(error.message),
  );
});

test('returns the control plane message for a bad key', async () => {
  const invalid = JSON.stringify({ code: 'API_KEY_INVALID', detail: 'The Project API Key is invalid or no longer active.' });
  await assert.rejects(connectionTest(401, invalid).result, { message: 'The Project API Key is invalid or no longer active.' });
});
