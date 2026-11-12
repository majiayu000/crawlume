// Checks the trigger's verifier against the signer in crawlume/sdk/webhooks. Run after `bun run build`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { generateWebhookSecret, signWebhook } from '../../../src/sdk/webhooks.ts';

const { verifyWebhookSignature } = createRequire(import.meta.url)('../dist/nodes/Crawlume/GenericFunctions.js');

const body = JSON.stringify({ id: 'evt_1', type: 'job.completed', data: { job_id: 'job_1' } });
const now = Date.now();
const timestamp = Math.floor(now / 1_000);
const secret = generateWebhookSecret();
const headers = (signature, at = timestamp) => ({
	'webhook-id': 'msg_1',
	'webhook-timestamp': String(at),
	'webhook-signature': signature,
});

test('accepts an SDK-signed delivery', () => {
	const signature = signWebhook([secret], 'msg_1', timestamp, body);
	assert.equal(verifyWebhookSignature({ secrets: [secret], headers: headers(signature), body, nowMs: now }), null);
});

test('accepts either secret during a rotation', () => {
	const rotated = generateWebhookSecret();
	const signature = signWebhook([rotated, secret], 'msg_1', timestamp, body);
	assert.equal(verifyWebhookSignature({ secrets: [secret], headers: headers(signature), body, nowMs: now }), null);
});

test('rejects a tampered body, a wrong secret and a stale timestamp', () => {
	const signature = signWebhook([secret], 'msg_1', timestamp, body);
	assert.match(verifyWebhookSignature({ secrets: [secret], headers: headers(signature), body: `${body} `, nowMs: now }), /No webhook signature/);
	assert.match(verifyWebhookSignature({ secrets: [generateWebhookSecret()], headers: headers(signature), body, nowMs: now }), /No webhook signature/);
	const stale = signWebhook([secret], 'msg_1', timestamp - 301, body);
	assert.match(verifyWebhookSignature({ secrets: [secret], headers: headers(stale, timestamp - 301), body, nowMs: now }), /tolerance/);
	assert.match(verifyWebhookSignature({ secrets: [secret], headers: {}, body, nowMs: now }), /Missing/);
});
