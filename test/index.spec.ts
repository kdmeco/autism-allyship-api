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
const GOOGLE_APIS_ORIGIN = 'https://www.googleapis.com';
const JWKS_PATH = '/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com';
const DOCS_PATH = '/v1/projects/autism-allyship/databases/(default)/documents';

let privateKeyPem: string;

// A second, independent RSA pair for admin ID tokens: the upload Worker's
// test file signs with one key and serves its public half from a mocked
// JWKS endpoint, and this file does the same thing for the same reason,
// verifying it is Google's job in production, not this test's.
let adminSigningKey: CryptoKey;
let adminVerifyingJwk: JsonWebKey & { kid: string };

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair;
	const exported = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
	privateKeyPem = pemWrap(exported);

	const adminPair = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair;
	adminSigningKey = adminPair.privateKey;
	adminVerifyingJwk = { ...(await crypto.subtle.exportKey('jwk', adminPair.publicKey)), kid: 'test-admin-key' };

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
	fetchMock.get(GOOGLE_APIS_ORIGIN).intercept({ path: JWKS_PATH }).reply(200, { keys: [adminVerifyingJwk] }).persist();
});

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
	return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function mintAdminToken(claims: Record<string, unknown> = {}): Promise<string> {
	const header = encodeJson({ alg: 'RS256', kid: adminVerifyingJwk.kid });
	const payload = encodeJson({
		iss: 'https://securetoken.google.com/autism-allyship',
		aud: 'autism-allyship',
		exp: Math.floor(Date.now() / 1000) + 3600,
		sub: 'admin-uid',
		...claims,
	});
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', adminSigningKey, new TextEncoder().encode(`${header}.${payload}`));
	return `${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

// Queues the admins/{uid} lookup verifyAdmin() makes once the token itself
// checks out: found means the caller is an admin, 404 means they are not.
function mockAdminDoc(uid: string, isAdmin: boolean): void {
	fetchMock
		.get(FIRESTORE_ORIGIN)
		.intercept({ path: DOCS_PATH + '/admins/' + uid, method: 'GET' })
		.reply(isAdmin ? 200 : 404, isAdmin ? { fields: {} } : { error: { message: 'not found' } });
}

function mockTicketGet(token: string, ticket: Record<string, unknown> | null): void {
	fetchMock
		.get(FIRESTORE_ORIGIN)
		.intercept({ path: DOCS_PATH + '/tickets/' + token, method: 'GET' })
		.reply(ticket ? 200 : 404, ticket ? { fields: ticket } : { error: { message: 'not found' } });
}

// DOCS_PATH contains literal parentheses ("(default)"), which are regex
// metacharacters: unescaped, they read as a capture group for the text
// "default" rather than a match for the literal parens Firestore's URL
// actually has, and the mock silently never matches. Escaped here so the
// path is matched literally up to the query string, whatever the exact
// updateMask field order turns out to be.
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mockTicketPatch(token: string): void {
	fetchMock
		.get(FIRESTORE_ORIGIN)
		.intercept({ path: new RegExp('^' + escapeRegExp(DOCS_PATH + '/tickets/' + token) + '\\?'), method: 'PATCH' })
		.reply(200, {});
}

function ticketFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		token: firestoreValue('test-token'),
		eventId: firestoreValue('event-1'),
		eventTitle: firestoreValue('Test Event'),
		attendeeName: firestoreValue('Durell Jardim'),
		attendeeEmail: firestoreValue('durell@example.com'),
		quantity: firestoreValue(2),
		price: firestoreValue(0),
		paystackRef: firestoreValue(''),
		redeemed: firestoreValue(false),
		...overrides,
	};
}

async function postAdmin(
	path: string,
	body: Record<string, unknown>,
	token: string | null,
	env: typeof testEnv = testEnv,
): Promise<Response> {
	const ctx = createExecutionContext();
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Origin: 'https://staging.autism-allyship.pages.dev',
	};
	if (token) {
		headers.Authorization = 'Bearer ' + token;
	}
	const response = await worker.fetch(new Request('https://worker' + path, { method: 'POST', headers, body: JSON.stringify(body) }), env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

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

async function post(
	body: string,
	headers: Record<string, string> = {},
	path = '/ticket',
	env: typeof testEnv = testEnv,
): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request('https://worker' + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'https://staging.autism-allyship.pages.dev', ...headers },
			body,
		}),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

const BREVO_ORIGIN = 'https://api.brevo.com';
const envWithBrevo = { ...testEnv, BREVO_API_KEY: 'test-brevo-key' };

// Registered after mockAttempt() for the same test, since the code only
// reaches the Brevo call once the Firestore transaction has already
// committed and returned a token.
function mockBrevo(status: 200 | 401): void {
	fetchMock
		.get(BREVO_ORIGIN)
		.intercept({ path: '/v3/smtp/email', method: 'POST' })
		.reply(status, status === 200 ? { messageId: 'test-message-id' } : { message: 'Key not found' });
}

const PAYSTACK_ORIGIN = 'https://api.paystack.co';
const envWithPaystack = { ...testEnv, PAYSTACK_SECRET_KEY: 'sk_test_123' };

function donateBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		amount: 150,
		donorName: 'Durell Jardim',
		donorEmail: 'durell@example.com',
		message: '',
		...overrides,
	});
}

function mockPaystackInitialize(status: 200 | 401, reference = 'ref-1'): void {
	fetchMock
		.get(PAYSTACK_ORIGIN)
		.intercept({ path: '/transaction/initialize', method: 'POST' })
		.reply(
			status,
			status === 200
				? {
						status: true,
						message: 'Authorization URL created',
						data: { authorization_url: 'https://checkout.paystack.com/x', access_code: 'access-1', reference },
					}
				: { status: false, message: 'Invalid key' },
		);
}

function mockDonationCreate(reference: string): void {
	fetchMock
		.get(FIRESTORE_ORIGIN)
		.intercept({ path: new RegExp('^' + escapeRegExp(DOCS_PATH + '/donations') + '\\?documentId=' + escapeRegExp(reference)), method: 'POST' })
		.reply(200, {});
}

function mockDonationGet(reference: string, donation: Record<string, unknown> | null): void {
	fetchMock
		.get(FIRESTORE_ORIGIN)
		.intercept({ path: DOCS_PATH + '/donations/' + reference, method: 'GET' })
		.reply(donation ? 200 : 404, donation ? { fields: donation } : { error: { message: 'not found' } });
}

function mockDonationPatch(reference: string): void {
	fetchMock
		.get(FIRESTORE_ORIGIN)
		.intercept({ path: new RegExp('^' + escapeRegExp(DOCS_PATH + '/donations/' + reference) + '\\?'), method: 'PATCH' })
		.reply(200, {});
}

function mockPaystackVerify(reference: string, status: 200 | 401, paystackStatus: 'success' | 'failed' = 'success'): void {
	fetchMock
		.get(PAYSTACK_ORIGIN)
		.intercept({ path: '/transaction/verify/' + reference, method: 'GET' })
		.reply(
			status,
			status === 200
				? {
						status: true,
						message: 'Verification successful',
						data: { status: paystackStatus, gateway_response: paystackStatus === 'success' ? 'Successful' : 'Declined' },
					}
				: { status: false, message: 'Invalid key' },
		);
}

function firestoreDouble(value: number) {
	return { doubleValue: value };
}

function donationFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		amount: firestoreDouble(150),
		donorName: firestoreValue('Durell Jardim'),
		donorEmail: firestoreValue('durell@example.com'),
		message: firestoreValue(''),
		paystackRef: firestoreValue('ref-1'),
		status: firestoreValue('pending'),
		...overrides,
	};
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

	it('sends a confirmation email and reports emailSent true when Brevo accepts it', async () => {
		mockAttempt({ event: eventFields({ capacity: 10, ticketsSold: 3 }), result: 'committed' });
		mockBrevo(200);
		const response = await post(registerBody({ quantity: 2 }), {}, '/ticket', envWithBrevo);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; token: string; emailSent: boolean };
		expect(result.ok).toBe(true);
		expect(result.token).toBeTruthy();
		expect(result.emailSent).toBe(true);
	});

	it('still returns a valid ticket, with emailSent false, when Brevo rejects the request', async () => {
		mockAttempt({ event: eventFields({ capacity: 10, ticketsSold: 3 }), result: 'committed' });
		mockBrevo(401);
		const response = await post(registerBody({ quantity: 2 }), {}, '/ticket', envWithBrevo);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; token: string; emailSent: boolean };
		expect(result.ok).toBe(true);
		expect(result.token).toBeTruthy();
		expect(result.emailSent).toBe(false);
	});

	it('still returns a valid ticket, with emailSent false, when no Brevo key is configured', async () => {
		// No mockBrevo() call: BREVO_API_KEY is absent from plain testEnv, so
		// the code must never attempt the call at all. If it did, fetchMock's
		// disableNetConnect() from beforeEach would fail this test with an
		// unmocked-request error rather than a clean false.
		mockAttempt({ event: eventFields({ capacity: 10, ticketsSold: 3 }), result: 'committed' });
		const response = await post(registerBody({ quantity: 2 }));
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; token: string; emailSent: boolean };
		expect(result.ok).toBe(true);
		expect(result.token).toBeTruthy();
		expect(result.emailSent).toBe(false);
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

describe('admin attendee actions', () => {
	it('refuses resend with no Authorization header at all', async () => {
		const response = await postAdmin('/attendees/resend', { token: 'tok-1' }, null);
		expect(response.status).toBe(401);
	});

	it('refuses a signed in user who is not an admin', async () => {
		mockAdminDoc('admin-uid', false);
		const token = await mintAdminToken();
		const response = await postAdmin('/attendees/resend', { token: 'tok-1' }, token);
		expect(response.status).toBe(401);
	});

	it('refuses a token signed with the wrong key', async () => {
		const rogue = (await crypto.subtle.generateKey(
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
			true,
			['sign', 'verify'],
		)) as CryptoKeyPair;
		const header = encodeJson({ alg: 'RS256', kid: adminVerifyingJwk.kid });
		const payload = encodeJson({
			iss: 'https://securetoken.google.com/autism-allyship',
			aud: 'autism-allyship',
			exp: Math.floor(Date.now() / 1000) + 3600,
			sub: 'admin-uid',
		});
		const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rogue.privateKey, new TextEncoder().encode(`${header}.${payload}`));
		const forged = `${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
		const response = await postAdmin('/attendees/resend', { token: 'tok-1' }, forged);
		expect(response.status).toBe(401);
	});

	it('rejects resend without a ticket token in the body', async () => {
		mockAdminDoc('admin-uid', true);
		const token = await mintAdminToken();
		const response = await postAdmin('/attendees/resend', {}, token);
		expect(response.status).toBe(400);
	});

	it('answers 404 when the ticket does not exist', async () => {
		mockAdminDoc('admin-uid', true);
		mockTicketGet('missing-token', null);
		const token = await mintAdminToken();
		const response = await postAdmin('/attendees/resend', { token: 'missing-token' }, token);
		expect(response.status).toBe(404);
	});

	it('resends the confirmation email for an existing ticket and reports emailSent', async () => {
		mockAdminDoc('admin-uid', true);
		mockTicketGet('tok-1', ticketFields());
		mockBrevo(200);
		const token = await mintAdminToken();
		const response = await postAdmin('/attendees/resend', { token: 'tok-1' }, token, envWithBrevo);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; emailSent: boolean };
		expect(result.ok).toBe(true);
		expect(result.emailSent).toBe(true);
	});

	it('rejects an edit with an invalid replacement email', async () => {
		mockAdminDoc('admin-uid', true);
		const token = await mintAdminToken();
		const response = await postAdmin('/attendees/edit-email', { token: 'tok-1', newEmail: 'not-an-email' }, token);
		expect(response.status).toBe(400);
	});

	it('updates the email and resends to the corrected address', async () => {
		mockAdminDoc('admin-uid', true);
		mockTicketGet('tok-1', ticketFields());
		mockTicketPatch('tok-1');
		mockTicketGet('tok-1', ticketFields({ attendeeEmail: firestoreValue('corrected@example.com') }));
		mockBrevo(200);
		const token = await mintAdminToken();
		const response = await postAdmin('/attendees/edit-email', { token: 'tok-1', newEmail: 'corrected@example.com' }, token, envWithBrevo);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; emailSent: boolean };
		expect(result.ok).toBe(true);
		expect(result.emailSent).toBe(true);
	});

	it('marks an unredeemed ticket used', async () => {
		mockAdminDoc('admin-uid', true);
		mockTicketGet('tok-1', ticketFields({ redeemed: firestoreValue(false) }));
		mockTicketPatch('tok-1');
		const token = await mintAdminToken();
		const response = await postAdmin('/attendees/mark-used', { token: 'tok-1' }, token);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean };
		expect(result.ok).toBe(true);
	});

	it('refuses to mark an already-redeemed ticket used again', async () => {
		mockAdminDoc('admin-uid', true);
		mockTicketGet('tok-1', ticketFields({ redeemed: firestoreValue(true) }));
		const token = await mintAdminToken();
		const response = await postAdmin('/attendees/mark-used', { token: 'tok-1' }, token);
		expect(response.status).toBe(409);
	});

	it('answers 404 for an admin action on a ticket that does not exist', async () => {
		mockAdminDoc('admin-uid', true);
		mockTicketGet('missing-token', null);
		const token = await mintAdminToken();
		const response = await postAdmin('/attendees/mark-used', { token: 'missing-token' }, token);
		expect(response.status).toBe(404);
	});
});

function contactBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		name: 'Alex Tester',
		email: 'alex@example.com',
		phone: '012 345 6789',
		category: 'General',
		message: 'Please tell me about upcoming events.',
		...overrides,
	});
}

describe('the contact notify endpoint', () => {
	it('refuses an origin that is not one of ours', async () => {
		const response = await post(contactBody(), { Origin: 'https://evil.example' }, '/contact-notify');
		expect(response.status).toBe(403);
	});

	it('rejects a malformed JSON body', async () => {
		const response = await post('{not json', {}, '/contact-notify');
		expect(response.status).toBe(400);
	});

	it('rejects a missing name', async () => {
		const response = await post(contactBody({ name: '' }), {}, '/contact-notify');
		expect(response.status).toBe(400);
	});

	it('rejects an invalid email', async () => {
		const response = await post(contactBody({ email: 'not-an-email' }), {}, '/contact-notify');
		expect(response.status).toBe(400);
	});

	it('rejects a missing message', async () => {
		const response = await post(contactBody({ message: '' }), {}, '/contact-notify');
		expect(response.status).toBe(400);
	});

	it('rejects a category that is not one the form stores', async () => {
		const response = await post(contactBody({ category: 'spam' }), {}, '/contact-notify');
		expect(response.status).toBe(400);
	});

	it('sends the notify email and reports emailSent true when Brevo accepts it', async () => {
		mockBrevo(200);
		const response = await post(contactBody(), {}, '/contact-notify', envWithBrevo);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; emailSent: boolean };
		expect(result.ok).toBe(true);
		expect(result.emailSent).toBe(true);
	});

	it('still returns ok, with emailSent false, when Brevo rejects the request', async () => {
		mockBrevo(401);
		const response = await post(contactBody(), {}, '/contact-notify', envWithBrevo);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; emailSent: boolean };
		expect(result.ok).toBe(true);
		expect(result.emailSent).toBe(false);
	});

	it('still returns ok, with emailSent false, when no Brevo key is configured', async () => {
		const response = await post(contactBody(), {}, '/contact-notify');
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; emailSent: boolean };
		expect(result.ok).toBe(true);
		expect(result.emailSent).toBe(false);
	});

	it('allows the origin in preflights', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request('https://worker/contact-notify', {
				method: 'OPTIONS',
				headers: {
					Origin: 'http://127.0.0.1:5500',
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers': 'content-type',
				},
			}),
			testEnv,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:5500');
	});
});

describe('the donation initialize endpoint', () => {
	it('refuses an origin that is not one of ours', async () => {
		const response = await post(donateBody(), { Origin: 'https://evil.example' }, '/donations/initialize');
		expect(response.status).toBe(403);
	});

	it('rejects a malformed JSON body', async () => {
		const response = await post('{not json', {}, '/donations/initialize');
		expect(response.status).toBe(400);
	});

	it('rejects an amount of zero', async () => {
		const response = await post(donateBody({ amount: 0 }), {}, '/donations/initialize');
		expect(response.status).toBe(400);
	});

	it('rejects a missing name', async () => {
		const response = await post(donateBody({ donorName: '' }), {}, '/donations/initialize');
		expect(response.status).toBe(400);
	});

	it('rejects an invalid email', async () => {
		const response = await post(donateBody({ donorEmail: 'not-an-email' }), {}, '/donations/initialize');
		expect(response.status).toBe(400);
	});

	it('returns 502 when Paystack refuses to initialize the transaction', async () => {
		mockPaystackInitialize(401);
		const response = await post(donateBody(), {}, '/donations/initialize', envWithPaystack);
		expect(response.status).toBe(502);
	});

	it('creates a pending donation record and returns the access code and reference', async () => {
		mockPaystackInitialize(200, 'ref-1');
		mockDonationCreate('ref-1');
		const response = await post(donateBody(), {}, '/donations/initialize', envWithPaystack);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; accessCode: string; reference: string };
		expect(result.ok).toBe(true);
		expect(result.accessCode).toBe('access-1');
		expect(result.reference).toBe('ref-1');
	});


	it('allows the origin in preflights', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request('https://worker/donations/initialize', {
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

describe('the donation verify endpoint', () => {
	it('rejects a missing reference', async () => {
		const response = await post(JSON.stringify({}), {}, '/donations/verify');
		expect(response.status).toBe(400);
	});

	it('answers 404 when the donation does not exist', async () => {
		mockDonationGet('missing-ref', null);
		const response = await post(JSON.stringify({ reference: 'missing-ref' }), {}, '/donations/verify', envWithPaystack);
		expect(response.status).toBe(404);
	});

	it('confirms a successful payment and marks the donation successful', async () => {
		mockDonationGet('ref-1', donationFields());
		mockPaystackVerify('ref-1', 200, 'success');
		mockDonationPatch('ref-1');
		const response = await post(JSON.stringify({ reference: 'ref-1' }), {}, '/donations/verify', envWithPaystack);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; status: string; amount: number; donorName: string };
		expect(result.ok).toBe(true);
		expect(result.status).toBe('success');
		expect(result.amount).toBe(150);
		expect(result.donorName).toBe('Durell Jardim');
	});

	it('marks a declined payment as failed', async () => {
		mockDonationGet('ref-2', donationFields({ paystackRef: firestoreValue('ref-2') }));
		mockPaystackVerify('ref-2', 200, 'failed');
		mockDonationPatch('ref-2');
		const response = await post(JSON.stringify({ reference: 'ref-2' }), {}, '/donations/verify', envWithPaystack);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; status: string };
		expect(result.status).toBe('failed');
	});

	it('does not call Paystack again for a donation already resolved', async () => {
		mockDonationGet('ref-3', donationFields({ status: firestoreValue('success') }));
		// No mockPaystackVerify() call: fetchMock's disableNetConnect() from
		// beforeEach fails this test if the code asks Paystack again for a
		// donation that was already resolved by an earlier call.
		const response = await post(JSON.stringify({ reference: 'ref-3' }), {}, '/donations/verify', envWithPaystack);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; status: string };
		expect(result.status).toBe('success');
	});

	it('returns 502 when Paystack cannot verify the transaction', async () => {
		mockDonationGet('ref-4', donationFields());
		mockPaystackVerify('ref-4', 401);
		const response = await post(JSON.stringify({ reference: 'ref-4' }), {}, '/donations/verify', envWithPaystack);
		expect(response.status).toBe(502);
	});
});
