// Public API Worker for the Autism Allyship Foundation site. Starts with one
// endpoint, free-event ticket registration, and is the intended home for the
// Paystack and Brevo endpoints once those sections are built. Kept separate
// from the image upload Worker because this endpoint is called anonymously
// by any visitor, and the upload Worker holds a GitHub token with full repo
// scope: an anonymous route has no business sharing a process with that.

interface Env {
	FIREBASE_PROJECT_ID: string;
	FIREBASE_SERVICE_ACCOUNT: string; // secret: the whole downloaded service account JSON key file, as text
	BREVO_API_KEY?: string; // secret: absent until Section 6's Brevo setup is done, and the confirmation email is skipped rather than failing the registration until then
}

const TICKET_PATH = '/ticket';

// A family arrives together, per SCHEMA.md's reasoning for why one booking
// covers a quantity rather than issuing one ticket per person. Past ten this
// stops looking like a family and starts looking like a script.
const MAX_QUANTITY = 10;
const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 320; // the longest an email address can be under RFC 5321
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Optimistic concurrency: Firestore aborts the commit if another request
// touched the same event document between our read and our write. Two
// people registering for the last seat at once must not both succeed, so a
// collision here is expected under load, not a bug, and is worth one retry
// before giving up.
const MAX_TRANSACTION_ATTEMPTS = 3;

interface RegisterRequest {
	eventId: string;
	attendeeName: string;
	attendeeEmail: string;
	quantity: number;
}

// Same origin policy as the upload Worker: the project's own Pages
// addresses, including the per-push preview hosts, plus the Live Server
// address used for local development. Kept in sync by hand rather than
// shared, because these are two independently deployed Workers.
function allowedOrigin(request: Request): string | null {
	const origin = request.headers.get('Origin');
	if (!origin) {
		return null;
	}
	const ours =
		origin === 'https://autism-allyship.pages.dev' ||
		origin.endsWith('.autism-allyship.pages.dev') ||
		origin === 'http://localhost:5500' ||
		origin === 'http://127.0.0.1:5500';
	return ours ? origin : '';
}

function corsHeaders(origin: string | null): Record<string, string> {
	if (!origin) {
		return {};
	}
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
	};
}

function json(data: unknown, status: number, origin: string | null): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders(origin),
		},
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const origin = allowedOrigin(request);

		if (request.method === 'OPTIONS') {
			if (origin === '') {
				return json({ error: 'Not allowed' }, 403, origin);
			}
			return new Response(null, { status: 204, headers: corsHeaders(origin) });
		}

		const pathname = new URL(request.url).pathname;
		if (pathname !== TICKET_PATH) {
			return json({ error: 'Not found' }, 404, origin);
		}

		if (request.method !== 'POST') {
			return json({ error: 'Method not allowed' }, 405, origin);
		}

		if (origin === '') {
			return json({ error: 'Not allowed' }, 403, origin);
		}

		let body: RegisterRequest;
		try {
			body = (await request.json()) as RegisterRequest;
		} catch {
			return json({ error: 'Invalid JSON body' }, 400, origin);
		}

		const validationError = validateRequest(body);
		if (validationError) {
			return json({ error: validationError }, 400, origin);
		}

		try {
			const result = await registerTicket(env, body);
			if ('error' in result) {
				return json({ error: result.error }, result.status, origin);
			}

			// Sending is never allowed to fail the registration: the ticket
			// already exists by the time this runs, and the visitor already has
			// the link on screen. The page is told honestly whether it went out,
			// rather than the response claiming success unconditionally.
			const ticketUrl = origin + '/ticket.html?token=' + encodeURIComponent(result.token);
			const emailSent = await sendConfirmationEmail(env, {
				ticketUrl,
				eventTitle: result.eventTitle,
				eventStartsAt: result.eventStartsAt,
				attendeeName: body.attendeeName.trim(),
				attendeeEmail: body.attendeeEmail.trim(),
				quantity: body.quantity,
			});

			return json({ ok: true, token: result.token, emailSent }, 200, origin);
		} catch (error) {
			console.error('Ticket registration failed:', error);
			return json({ error: 'Registration failed. Try again.' }, 500, origin);
		}
	},
};

function validateRequest(body: RegisterRequest): string | null {
	if (!body.eventId || typeof body.eventId !== 'string') {
		return 'An event is required.';
	}
	if (!body.attendeeName || typeof body.attendeeName !== 'string' || body.attendeeName.trim() === '') {
		return 'Please enter a name.';
	}
	if (body.attendeeName.length > MAX_NAME_LENGTH) {
		return 'That name is too long.';
	}
	if (!body.attendeeEmail || typeof body.attendeeEmail !== 'string' || !EMAIL_PATTERN.test(body.attendeeEmail)) {
		return 'Please enter a valid email address.';
	}
	if (body.attendeeEmail.length > MAX_EMAIL_LENGTH) {
		return 'That email address is too long.';
	}
	if (!Number.isInteger(body.quantity) || body.quantity < 1) {
		return 'Quantity must be at least 1.';
	}
	if (body.quantity > MAX_QUANTITY) {
		return 'Bookings are limited to ' + MAX_QUANTITY + ' people. Contact the foundation for a larger group.';
	}
	return null;
}

type RegisterResult =
	| { token: string; eventTitle: string; eventStartsAt: string | null }
	| { error: string; status: number };

// Reads the event, checks it is bookable, checks capacity and creates the
// ticket, all inside one Firestore transaction. The read of the event
// document happens through the transaction, so if two requests race for the
// last seats, the second one to commit is told the transaction aborted and
// retries against the now-current ticketsSold rather than silently
// overselling.
async function registerTicket(env: Env, body: RegisterRequest): Promise<RegisterResult> {
	const accessToken = await getAccessToken(env);

	for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
		const transactionId = await beginTransaction(env, accessToken);

		const eventDoc = await getDocument(env, accessToken, 'events/' + body.eventId, transactionId);
		if (!eventDoc) {
			await rollback(env, accessToken, transactionId);
			return { error: 'That event could not be found.', status: 404 };
		}

		const event = parseFields(eventDoc.fields || {});
		const published = event.published === true;
		const isTicketed = event.isTicketed === true;
		const startsAt = typeof event.startsAt === 'string' ? new Date(event.startsAt) : null;
		const capacity = typeof event.capacity === 'number' ? event.capacity : 0;
		const ticketsSold = typeof event.ticketsSold === 'number' ? event.ticketsSold : 0;

		if (!published) {
			await rollback(env, accessToken, transactionId);
			return { error: 'That event could not be found.', status: 404 };
		}
		if (!startsAt || Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
			await rollback(env, accessToken, transactionId);
			return { error: 'This event has already happened.', status: 400 };
		}
		if (isTicketed) {
			// The paid path is built in Section 7, against Paystack. This
			// endpoint only ever issues free tickets.
			await rollback(env, accessToken, transactionId);
			return { error: 'This event requires payment and cannot be booked here yet.', status: 400 };
		}

		const newTotal = ticketsSold + body.quantity;
		if (capacity !== 0 && newTotal > capacity) {
			await rollback(env, accessToken, transactionId);
			const remaining = Math.max(capacity - ticketsSold, 0);
			return {
				error: remaining === 0 ? 'This event is sold out.' : 'Only ' + remaining + ' ' + (remaining === 1 ? 'spot' : 'spots') + ' left.',
				status: 409,
			};
		}

		const token = generateToken();
		const eventTitle = typeof event.title === 'string' ? event.title : 'Untitled';
		const eventStartsAt = typeof event.startsAt === 'string' ? event.startsAt : null;

		const writes = [
			{
				update: {
					name: documentName(env, 'events/' + body.eventId),
					fields: { ticketsSold: integerValue(newTotal) },
				},
				updateMask: { fieldPaths: ['ticketsSold'] },
			},
			{
				update: {
					name: documentName(env, 'tickets/' + token),
					fields: {
						token: stringValue(token),
						eventId: stringValue(body.eventId),
						eventTitle: stringValue(eventTitle),
						...(eventStartsAt ? { eventStartsAt: timestampValue(eventStartsAt) } : {}),
						attendeeName: stringValue(body.attendeeName.trim()),
						attendeeEmail: stringValue(body.attendeeEmail.trim()),
						quantity: integerValue(body.quantity),
						price: integerValue(0),
						paystackRef: stringValue(''),
						redeemed: booleanValue(false),
					},
				},
				// This is what makes the write a create rather than an
				// overwrite. The token is generated from 20 random bytes, so a
				// collision is not realistically expected, but refusing to
				// silently overwrite an existing ticket costs nothing.
				currentDocument: { exists: false },
			},
		];

		const committed = await commit(env, accessToken, transactionId, writes);
		if (committed) {
			return { token, eventTitle, eventStartsAt };
		}
		// Aborted: someone else wrote to the event between our read and our
		// commit. Loop and try again against the fresh state.
	}

	return { error: 'Could not complete the booking, please try again.', status: 409 };
}

// --- Confirmation email ---
//
// Sent through Brevo's transactional email API. The sender address is a
// personal Gmail rather than the foundation's own domain: a single verified
// sender works immediately with no DNS access, whereas sending as
// info@autismallyship.org needs SPF and DKIM records added to their DNS,
// which is the "verify the sending domain" line in CONSOLE-STEPS.md's
// Still to come. Mail may land in spam until that is done. Fine for testing,
// must be fixed before launch.
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const SENDER_EMAIL = 'durellvicjardim@gmail.com';
const SENDER_NAME = 'Autism Allyship Foundation';

interface ConfirmationEmailInput {
	ticketUrl: string;
	eventTitle: string;
	eventStartsAt: string | null;
	attendeeName: string;
	attendeeEmail: string;
	quantity: number;
}

// Never allowed to fail the registration: the ticket already exists in
// Firestore by the time this runs, and the visitor already has the link on
// screen either way. A missing key, a Brevo outage, or a rejected request is
// logged and swallowed, and the caller is told honestly whether it went out
// so the confirmation page never claims an email that was not actually sent.
async function sendConfirmationEmail(env: Env, input: ConfirmationEmailInput): Promise<boolean> {
	if (!env.BREVO_API_KEY) {
		return false;
	}

	// Per SCHEMA.md: never "this ticket belongs to", since a booking is
	// transferable at no cost and forwarding the link is expected use.
	const bookedBy =
		input.quantity === 1 ? `Booked by ${input.attendeeName}, 1 person` : `Booked by ${input.attendeeName}, ${input.quantity} people`;
	const when = input.eventStartsAt ? formatEventTime(input.eventStartsAt) : '';

	try {
		const response = await fetch(BREVO_API_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'api-key': env.BREVO_API_KEY,
			},
			body: JSON.stringify({
				sender: { name: SENDER_NAME, email: SENDER_EMAIL },
				to: [{ email: input.attendeeEmail, name: input.attendeeName }],
				subject: `Your ticket for ${input.eventTitle}`,
				htmlContent: buildEmailHtml(input, bookedBy, when),
				textContent: buildEmailText(input, bookedBy, when),
			}),
		});
		if (!response.ok) {
			console.error('Brevo send failed:', response.status, await response.text());
			return false;
		}
		return true;
	} catch (error) {
		console.error('Brevo send threw:', error);
		return false;
	}
}

function formatEventTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	return date.toLocaleDateString('en-ZA') + ' ' + date.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
}

// The ticket link goes in as a plain visible URL, not only inside a styled
// button: a link someone can select and copy straight out of a mail client
// is the fallback for when every other save action in the app has failed.
function buildEmailText(input: ConfirmationEmailInput, bookedBy: string, when: string): string {
	const lines = [
		`Your ticket for ${input.eventTitle}`,
		when ? `When: ${when}` : '',
		bookedBy,
		'',
		'This link is your ticket. There is no account to recover it from, so save it somewhere safe:',
		input.ticketUrl,
	];
	return lines.filter((line) => line !== '').join('\n');
}

function buildEmailHtml(input: ConfirmationEmailInput, bookedBy: string, when: string): string {
	return [
		`<p>Your ticket for <strong>${escapeHtml(input.eventTitle)}</strong></p>`,
		when ? `<p>${escapeHtml(when)}</p>` : '',
		`<p>${escapeHtml(bookedBy)}</p>`,
		`<p>This link is your ticket. There is no account to recover it from, so save it somewhere safe:<br>`,
		`<a href="${escapeHtml(input.ticketUrl)}">${escapeHtml(input.ticketUrl)}</a></p>`,
	]
		.filter((line) => line !== '')
		.join('\n');
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Twenty random bytes, base64url encoded, comes out to about 27 characters:
// inside the 20-to-30 range RULES-WEBSITE.md calls for, and short enough to
// keep the QR code's module count low. Base64url's alphabet has no "/", so
// the result is always a valid Firestore document ID on its own.
function generateToken(): string {
	const bytes = new Uint8Array(20);
	crypto.getRandomValues(bytes);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Firestore REST, minimal ---
//
// The Workers runtime has no Firebase Admin SDK, so this talks to the
// Firestore REST API directly: https://firestore.googleapis.com/v1/...
// A Firestore transaction here is begin, then reads carrying the
// transaction id, then one commit with every write. Firestore detects a
// conflict if any document read in the transaction changed before commit,
// and reports it by failing the commit rather than by the read itself.

function firestoreBase(env: Env): string {
	return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

function documentName(env: Env, path: string): string {
	return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
}

async function beginTransaction(env: Env, accessToken: string): Promise<string> {
	const response = await fetch(firestoreBase(env) + ':beginTransaction', {
		method: 'POST',
		headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
		body: JSON.stringify({ options: { readWrite: {} } }),
	});
	if (!response.ok) {
		throw new Error('Could not start a Firestore transaction: ' + response.status);
	}
	const data = (await response.json()) as { transaction: string };
	return data.transaction;
}

async function getDocument(
	env: Env,
	accessToken: string,
	path: string,
	transactionId: string,
): Promise<{ fields?: Record<string, unknown> } | null> {
	const url = firestoreBase(env) + '/' + path + '?transaction=' + encodeURIComponent(transactionId);
	const response = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw new Error('Could not read from Firestore: ' + response.status);
	}
	return (await response.json()) as { fields?: Record<string, unknown> };
}

// Returns true on a clean commit. Returns false specifically for the
// concurrency conflict (Firestore answers 409 ABORTED), which the caller
// retries. Any other failure is a real error and throws.
async function commit(env: Env, accessToken: string, transactionId: string, writes: unknown[]): Promise<boolean> {
	const response = await fetch(firestoreBase(env) + ':commit', {
		method: 'POST',
		headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
		body: JSON.stringify({ writes, transaction: transactionId }),
	});
	if (response.ok) {
		return true;
	}
	if (response.status === 409) {
		return false;
	}
	throw new Error('Could not save the booking: ' + response.status + ' ' + (await response.text()));
}

async function rollback(env: Env, accessToken: string, transactionId: string): Promise<void> {
	// Best-effort: releases the transaction's lock early rather than waiting
	// for the server-side timeout. A refused registration proceeds either
	// way, so a failure here is not worth surfacing to the visitor.
	try {
		await fetch(firestoreBase(env) + ':rollback', {
			method: 'POST',
			headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
			body: JSON.stringify({ transaction: transactionId }),
		});
	} catch (error) {
		console.error('Rollback failed (non-fatal):', error);
	}
}

function stringValue(value: string) {
	return { stringValue: value };
}
function integerValue(value: number) {
	return { integerValue: String(Math.trunc(value)) };
}
function booleanValue(value: boolean) {
	return { booleanValue: value };
}
function timestampValue(iso: string) {
	return { timestampValue: iso };
}

// Firestore's REST JSON wraps every value in a type tag, for example
// { stringValue: "x" } or { integerValue: "3" }. This unwraps just the
// types this Worker reads, into plain JS values, and ignores the rest.
function parseFields(fields: Record<string, any>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(fields)) {
		const value = fields[key];
		if ('stringValue' in value) {
			result[key] = value.stringValue;
		} else if ('integerValue' in value) {
			result[key] = parseInt(value.integerValue, 10);
		} else if ('doubleValue' in value) {
			result[key] = value.doubleValue;
		} else if ('booleanValue' in value) {
			result[key] = value.booleanValue;
		} else if ('timestampValue' in value) {
			result[key] = value.timestampValue;
		}
	}
	return result;
}

// --- Service account auth ---
//
// Exchanges the service account key for a short-lived OAuth access token,
// the same server-to-server flow the Firebase Admin SDK performs, done by
// hand because that SDK does not run in the Workers runtime. Cached in
// memory the same way the upload Worker caches Google's JWKS, so a burst of
// registrations does not mean a token exchange per request.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
let accessTokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(env: Env): Promise<string> {
	if (accessTokenCache && Date.now() < accessTokenCache.expiresAt) {
		return accessTokenCache.token;
	}

	const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) as {
		client_email: string;
		private_key: string;
	};

	const now = Math.floor(Date.now() / 1000);
	const claims = {
		iss: serviceAccount.client_email,
		scope: FIRESTORE_SCOPE,
		aud: TOKEN_URL,
		exp: now + 3600,
		iat: now,
	};
	const assertion = await signJwt(claims, serviceAccount.private_key);

	const response = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion,
		}),
	});
	if (!response.ok) {
		throw new Error('Could not authenticate to Firebase: ' + response.status + ' ' + (await response.text()));
	}
	const data = (await response.json()) as { access_token: string; expires_in: number };

	// Refreshed a minute early so a request straddling the expiry boundary
	// never hits Google with a token that just lapsed.
	accessTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
	return data.access_token;
}

async function signJwt(claims: Record<string, unknown>, privateKeyPem: string): Promise<string> {
	const header = { alg: 'RS256', typ: 'JWT' };
	const encodedHeader = base64UrlEncodeJson(header);
	const encodedClaims = base64UrlEncodeJson(claims);
	const signingInput = encodedHeader + '.' + encodedClaims;

	const key = await crypto.subtle.importKey(
		'pkcs8',
		pemToArrayBuffer(privateKeyPem),
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));

	return signingInput + '.' + base64UrlEncodeBytes(new Uint8Array(signature));
}

// The key ships from Google as PEM: base64 wrapped at 64 columns between
// "-----BEGIN PRIVATE KEY-----" and "-----END PRIVATE KEY-----". WebCrypto
// wants the raw DER bytes underneath that formatting.
function pemToArrayBuffer(pem: string): ArrayBuffer {
	const contents = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, '')
		.replace(/-----END PRIVATE KEY-----/, '')
		.replace(/\s+/g, '');
	const binary = atob(contents);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

function base64UrlEncodeJson(value: unknown): string {
	return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
