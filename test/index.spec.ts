import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../src/index';

// Same shape as the upload Worker's test file: real crypto for the parts
// that are actually cryptography, mocked network for everything that talks
// to Google. Here that means a fake service account signs a real JWT (the
// mock does not check the signature, since verifying it is Google's job,
// not this Worker's) and a fake Firestore stands in for the real one.

const FIRESTORE_ORIGIN = 'https://firestore.googleapis.com';
const OAUTH_ORIGIN = 'https://oauth2.googleapis.com';
const DOCS_PATH = '/v1/projects/autism-allyship/databases/(default)/documents';

let privateKeyPem: string;

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair;
	const exported = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
	privateKeyPem = pemWrap(exported);

	// Registered once, with persist(), the same way the upload Worker's test
	// file persists its JWKS mock: the Worker's access-token cache means only
	// the first test actually calls this endpoint, and a persisted mock
	// answers every call regardless of which test happens to be first.
	fetchMock.activate();
	fetchMock
		.get(OAUTH_ORIGIN)
		.intercept({ path: '/token', method: 'POST' })
		.reply(200, { access_token: 'test-access-token', expires_in: 3600, token_type: 'Bearer' })
		.persist();
});

const testEnv = {
	FIREBASE_PROJECT_ID: 'autism-allyship',
	get FIREBASE_SERVICE_ACCOUNT() {
		return JSON.stringify({ client_email: 'test@autism-allyship.iam.gserviceaccount.com', private_key: privateKeyPem });
	},
	...env,
};

function pemWrap(der: ArrayBuffer): string {
	let binary = '';
	for (const byte of new Uint8Array(der)) {
		binary += String.fromCharCode(byte);
	}
	const base64 = btoa(binary);
	const lines = base64.match(/.{1,64}/g) || [];
	return '-----BEGIN PRIVATE KEY-----\n' + lines.join('\n') + '\n-----END PRIVATE KEY-----\n';
}

function firestoreValue(value: string | number | boolean) {
	if (typeof value === 'string') return { stringValue: value };
	if (typeof value === 'boolean') return { booleanValue: value };
	return { integerValue: String(value) };
}

function eventFields(overrides: Record<string, string | number | boolean> = {}) {
	const base = {
		title: 'Test Event',
		published: true,
		isTicketed: false,
		capacity: 10,
		ticketsSold: 0,
		startsAt: new Date(Date.now() + 86400000).toISOString(), // tomorrow
		...overrides,
	};
	const fields: Record<string, unknown> = {};
	for (const key of Object.keys(base)) {
		fields[key] = firestoreValue((base as Record<string, string | number | boolean>)[key]);
	}
	return fields;
}

// Registers exactly the Firestore calls one transaction attempt in
// registerTicket() will make for a given scenario, and nothing more.
// fetchMock consumes interceptors in registration order per matching path,
// so a mock registered here that the code never actually calls would sit
// in the queue and get consumed by a later test's request instead of its
// own — which is exactly what happened before this was written to mirror
// the real call sequence for each outcome:
//
//   'missing'  -> begin, get (404), rollback                 [refused before commit]
//   'refused'  -> begin, get (200, some disqualifying field), rollback
//   'aborted'  -> begin, get (200), commit (409)              [no rollback: an
//                                                               aborted commit
//                                                               needs none]
//   'committed'-> begin, get (200), commit (200)
function mockAttempt(outcome: 'missing' | { event: Record<string, unknown>; result: 'refused' | 'aborted' | 'committed' }): void {
	fetchMock
		.get(FIRESTORE_ORIGIN)
		.intercept({ path: DOCS_PATH + ':beginTransaction', method: 'POST' })
		.reply(200, { transaction: 'txn-1' });

	if (outcome === 'missing') {
		fetchMock
			.get(FIRESTORE_ORIGIN)
			.intercept({ path: /\/documents\/events\/.+/, method: 'GET' })
			.reply(404, { error: { message: 'not found' } });
		fetchMock
			.get(FIRESTORE_ORIGIN)
			.intercept({ path: DOCS_PATH + ':rollback', method: 'POST' })
			.reply(200, {});
		return;
	}

	fetchMock
		.get(FIRESTORE_ORIGIN)
		.intercept({ path: /\/documents\/events\/.+/, method: 'GET' })
		.reply(200, { fields: outcome.event });

	if (outcome.result === 'refused') {
		fetchMock
			.get(FIRESTORE_ORIGIN)
			.intercept({ path: DOCS_PATH + ':rollback', method: 'POST' })
			.reply(200, {});
	} else if (outcome.result === 'aborted') {
		fetchMock
			.get(FIRESTORE_ORIGIN)
			.intercept({ path: DOCS_PATH + ':commit', method: 'POST' })
			.reply(409, { error: { status: 'ABORTED' } });
	} else {
		fetchMock
			.get(FIRESTORE_ORIGIN)
			.intercept({ path: DOCS_PATH + ':commit', method: 'POST' })
			.reply(200, {});
	}
}

beforeEach(() => {
	fetchMock.disableNetConnect();
});

function registerBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		eventId: 'event-1',
		attendeeName: 'Durell Jardim',
		attendeeEmail: 'durell@example.com',
		quantity: 2,
		...overrides,
	});
}

async function post(body: string, headers: Record<string, string> = {}, path = '/ticket'): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request('https://worker' + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'https://staging.autism-allyship.pages.dev', ...headers },
			body,
		}),
		testEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

describe('the ticket registration endpoint', () => {
	// The tests in this block are all rejected during input validation,
	// before registerTicket() ever calls Firestore. They deliberately do not
	// call mockAttempt(): fetchMock consumes interceptors in registration
	// order per matching path, so a mock set up here and never touched would
	// sit in the queue and get consumed by a later test's request instead of
	// its own mock.

	it('answers 404 for any other path', async () => {
		const response = await post(registerBody(), {}, '/somewhere-else');
		expect(response.status).toBe(404);
	});

	it('rejects a GET request', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request('https://worker/ticket', { method: 'GET', headers: { Origin: 'https://staging.autism-allyship.pages.dev' } }),
			testEnv,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
	});

	it('refuses an origin that is not one of ours', async () => {
		const response = await post(registerBody(), { Origin: 'https://evil.example' });
		expect(response.status).toBe(403);
	});

	it('rejects a malformed JSON body', async () => {
		const response = await post('{not json');
		expect(response.status).toBe(400);
	});

	it('rejects a missing name', async () => {
		const response = await post(registerBody({ attendeeName: '' }));
		expect(response.status).toBe(400);
	});

	it('rejects an invalid email', async () => {
		const response = await post(registerBody({ attendeeEmail: 'not-an-email' }));
		expect(response.status).toBe(400);
	});

	it('rejects a quantity of zero', async () => {
		const response = await post(registerBody({ quantity: 0 }));
		expect(response.status).toBe(400);
	});

	it('rejects a non-integer quantity', async () => {
		const response = await post(registerBody({ quantity: 2.5 }));
		expect(response.status).toBe(400);
	});

	it('rejects a quantity over the maximum group size', async () => {
		const response = await post(registerBody({ quantity: 11 }));
		expect(response.status).toBe(400);
	});

	it('refuses an event that does not exist', async () => {
		mockAttempt('missing');
		const response = await post(registerBody());
		expect(response.status).toBe(404);
	});

	it('refuses an unpublished event, the same as a missing one', async () => {
		mockAttempt({ event: eventFields({ published: false }), result: 'refused' });
		const response = await post(registerBody());
		expect(response.status).toBe(404);
	});

	it('refuses an event that has already happened', async () => {
		mockAttempt({ event: eventFields({ startsAt: new Date(Date.now() - 86400000).toISOString() }), result: 'refused' });
		const response = await post(registerBody());
		expect(response.status).toBe(400);
	});

	it('refuses a ticketed event, since this endpoint only issues free tickets', async () => {
		mockAttempt({ event: eventFields({ isTicketed: true }), result: 'refused' });
		const response = await post(registerBody());
		expect(response.status).toBe(400);
	});

	it('refuses a quantity that would exceed remaining capacity', async () => {
		mockAttempt({ event: eventFields({ capacity: 5, ticketsSold: 4 }), result: 'refused' }); // 1 spot left, asking for 2
		const response = await post(registerBody({ quantity: 2 }));
		expect(response.status).toBe(409);
	});

	it('refuses a sold out event', async () => {
		mockAttempt({ event: eventFields({ capacity: 5, ticketsSold: 5 }), result: 'refused' });
		const response = await post(registerBody());
		expect(response.status).toBe(409);
	});

	it('allows unlimited capacity when capacity is zero', async () => {
		mockAttempt({ event: eventFields({ capacity: 0, ticketsSold: 500 }), result: 'committed' });
		const response = await post(registerBody({ quantity: 10 }));
		expect(response.status).toBe(200);
	});

	it('creates a ticket for a valid free-event registration and returns a token', async () => {
		mockAttempt({ event: eventFields({ capacity: 10, ticketsSold: 3 }), result: 'committed' });
		const response = await post(registerBody({ quantity: 2 }));
		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://staging.autism-allyship.pages.dev');

		const result = (await response.json()) as { ok: boolean; token: string };
		expect(result.ok).toBe(true);
		// 20 random bytes, base64url, no padding: 27 characters, inside the
		// 20-30 range RULES-WEBSITE.md calls for.
		expect(result.token).toMatch(/^[A-Za-z0-9_-]{26,28}$/);
	});

	it('gives two registrations different tokens', async () => {
		mockAttempt({ event: eventFields(), result: 'committed' });
		const first = (await (await post(registerBody())).json()) as { token: string };
		mockAttempt({ event: eventFields(), result: 'committed' });
		const second = (await (await post(registerBody())).json()) as { token: string };
		expect(first.token).not.toBe(second.token);
	});

	it('retries once when the transaction is aborted by a concurrent write, then succeeds', async () => {
		// First attempt's commit collides (409), second attempt's commit
		// succeeds. Two full begin/get/commit rounds are queued in order.
		mockAttempt({ event: eventFields({ capacity: 10, ticketsSold: 3 }), result: 'aborted' });
		mockAttempt({ event: eventFields({ capacity: 10, ticketsSold: 4 }), result: 'committed' });
		const response = await post(registerBody({ quantity: 1 }));
		expect(response.status).toBe(200);
	});

	it('gives up after repeated aborts and reports a clear error', async () => {
		mockAttempt({ event: eventFields(), result: 'aborted' });
		mockAttempt({ event: eventFields(), result: 'aborted' });
		mockAttempt({ event: eventFields(), result: 'aborted' });
		const response = await post(registerBody());
		expect(response.status).toBe(409);
	});

	it('allows the origin in preflights', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request('https://worker/ticket', {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://staging.autism-allyship.pages.dev',
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers': 'content-type',
				},
			}),
			testEnv,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://staging.autism-allyship.pages.dev');
	});
});
