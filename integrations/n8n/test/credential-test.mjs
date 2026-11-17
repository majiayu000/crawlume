// Checks the credential test against the control plane's 404 bodies. Run after `bun run build`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { crawlumeApiTest } = createRequire(import.meta.url)('../dist/nodes/Crawlume/GenericFunctions.js');

const projectId = '22222222-2222-4222-8222-222222222222';
const credentialTest = (statusCode, body, data = {}) => {
	const requests = [];
	const context = {
		helpers: {
			request: async (options) => {
				requests.push(options.uri);
				return { statusCode, body };
			},
		},
	};
	const credential = { data: { baseUrl: 'https://control.example/v1/', projectId, apiKey: 'dya_live_key', ...data } };
	return crawlumeApiTest.call(context, credential).then((result) => ({ ...result, requests }));
};

test('accepts the 404 for a missing Job, which only an authenticated key reaches', async () => {
	const result = await credentialTest(404, { code: 'JOB_NOT_FOUND', detail: 'The Job does not exist in this project.' });
	assert.equal(result.status, 'OK');
	assert.deepEqual(result.requests, [`https://control.example/v1/projects/${projectId}/jobs/00000000-0000-4000-8000-000000000000`]);
});

test('rejects a 404 from routing, which is returned before the key is checked', async () => {
	const route = await credentialTest(
		404,
		{ code: 'PROJECT_ROUTE_NOT_FOUND', detail: 'The Project API route does not exist.' },
		{ projectId: 'my-project' },
	);
	assert.equal(route.status, 'Error');
	assert.match(route.message, /^The Project API route does not exist\. .*\/v1.*UUID/u);
	const worker = await credentialTest(404, { code: 'WORKER_ROUTE_NOT_FOUND', detail: 'The Worker API route does not exist.' });
	assert.equal(worker.status, 'Error');
	const html = await credentialTest(404, '<html>Not Found</html>');
	assert.equal(html.status, 'Error');
	assert.match(html.message, /^HTTP 404 /u);
});

test('returns the control plane message for a bad key', async () => {
	const result = await credentialTest(401, { code: 'API_KEY_INVALID', detail: 'The Project API Key is invalid or no longer active.' });
	assert.deepEqual({ status: result.status, message: result.message }, {
		status: 'Error',
		message: 'The Project API Key is invalid or no longer active.',
	});
});
