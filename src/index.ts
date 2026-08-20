// Public API Worker for the Autism Allyship Foundation site. Free-event
// ticket registration, the contact notify mail, the admin attendee actions,
// and now the Paystack donation flow. Kept separate from the image upload
// Worker because this endpoint is called anonymously by any visitor, and the
// upload Worker holds a GitHub token with full repo scope: an anonymous
// route has no business sharing a process with that.

interface Env {
	FIREBASE_PROJECT_ID: string;
	FIREBASE_SERVICE_ACCOUNT: string; // secret: the whole downloaded service account JSON key file, as text
	BREVO_API_KEY?: string; // secret: absent until Section 6's Brevo setup is done, and the confirmation email is skipped rather than failing the registration until then
	CONTACT_NOTIFY_EMAIL?: string; // secret: foundation inbox, or a personal inbox for the first live test. Falls back to info@autismallyship.org
	PAYSTACK_SECRET_KEY: string; // secret: the Paystack South Africa account's secret key, see CONSOLE-STEPS.md. Both donation endpoints fail cleanly with a 502 until this is set, the same as calling Paystack with any other wrong key would
}

const TICKET_PATH = '/ticket';
const CONTACT_NOTIFY_PATH = '/contact-notify';
const RESEND_PATH = '/attendees/resend';
const EDIT_EMAIL_PATH = '/attendees/edit-email';
const MARK_USED_PATH = '/attendees/mark-used';
const ADMIN_PATHS = [RESEND_PATH, EDIT_EMAIL_PATH, MARK_USED_PATH];
const DONATE_INITIALIZE_PATH = '/donations/initialize';
const DONATE_VERIFY_PATH = '/donations/verify';
const DEFAULT_CONTACT_NOTIFY_EMAIL = 'info@autismallyship.org';
const MAX_MESSAGE_LENGTH = 5000;
const MAX_PHONE_LENGTH = 40;
const CONTACT_CATEGORIES = ['General', 'volunteer', 'partnership', 'media', 'resource suggestion', 'accessibility'];

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

interface ContactNotifyRequest {
	name: string;
	email: string;
	phone: string;
	category: string;
	message: string;
}

interface DonationInitializeRequest {
	amount: number;
	donorName: string;
	donorEmail: string;
	message?: string;
}

interface DonationVerifyRequest {
	reference: string;
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
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

		if (request.method !== 'POST') {
			return json({ error: 'Method not allowed' }, 405, origin);
		}

		if (origin === '') {
			return json({ error: 'Not allowed' }, 403, origin);
		}

		if (ADMIN_PATHS.includes(pathname)) {
			return handleAdminRequest(request, env, origin, pathname);
		}

		if (pathname === CONTACT_NOTIFY_PATH) {
			return handleContactNotify(request, env, origin);
		}

		if (pathname === DONATE_INITIALIZE_PATH) {
			return handleDonationInitialize(request, env, origin);
		}

		if (pathname === DONATE_VERIFY_PATH) {
			return handleDonationVerify(request, env, origin);
		}

		if (pathname !== TICKET_PATH) {
			return json({ error: 'Not found' }, 404, origin);
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

// The contact form writes the Firestore document itself. This endpoint only
// sends the foundation a copy, and must not fail the visitor if mail fails:
// thank-you on the page means the document exists.
async function handleContactNotify(request: Request, env: Env, origin: string | null): Promise<Response> {
	let body: ContactNotifyRequest;
	try {
		body = (await request.json()) as ContactNotifyRequest;
	} catch {
		return json({ error: 'Invalid JSON body' }, 400, origin);
	}

	const validationError = validateContactNotify(body);
	if (validationError) {
		return json({ error: validationError }, 400, origin);
	}

	const emailSent = await sendContactNotifyEmail(env, {
		name: body.name.trim(),
		email: body.email.trim(),
		phone: typeof body.phone === 'string' ? body.phone.trim() : '',
		category: body.category,
		message: body.message.trim(),
	});

	return json({ ok: true, emailSent }, 200, origin);
}

function validateContactNotify(body: ContactNotifyRequest): string | null {
	if (!body.name || typeof body.name !== 'string' || body.name.trim() === '') {
		return 'Please enter a name.';
	}
	if (body.name.length > MAX_NAME_LENGTH) {
		return 'That name is too long.';
	}
	if (!body.email || typeof body.email !== 'string' || !EMAIL_PATTERN.test(body.email.trim())) {
		return 'Please enter a valid email address.';
	}
	if (body.email.length > MAX_EMAIL_LENGTH) {
		return 'That email address is too long.';
	}
	if (body.phone != null && typeof body.phone !== 'string') {
		return 'Please enter a valid phone number.';
	}
	if (typeof body.phone === 'string' && body.phone.length > MAX_PHONE_LENGTH) {
		return 'That phone number is too long.';
	}
	if (!body.category || typeof body.category !== 'string' || !CONTACT_CATEGORIES.includes(body.category)) {
		return 'Please choose a category.';
	}
	if (!body.message || typeof body.message !== 'string' || body.message.trim() === '') {
		return 'Please enter a message.';
	}
	if (body.message.length > MAX_MESSAGE_LENGTH) {
		return 'That message is too long.';
	}
	return null;
}

// --- Donations ---
//
// Two requests either side of the Paystack popup. Initialize creates the
// Paystack transaction and a matching Firestore document with status
// "pending", using the reference Paystack generates as the document ID, the
// same reasoning DECISIONS.md gives for tickets: it is not guessable, and
// storing it as the ID rather than a field means verify can read and update
// the right document directly rather than needing a query. Verify then
// confirms the outcome with Paystack and flips that one field. The amount,
// donor details and message are trusted from the initial request and never
// re-read from Paystack afterwards, because resumeTransaction() only ever
// resumes the exact transaction initialize created: nothing in the popup
// lets a visitor change the amount that was already sent to Paystack.
//
// Every donation is a single one-off transaction. A monthly/recurring option
// existed briefly and was removed: the foundation does not want it, so
// there is no Paystack Plan, no Subscription, and nothing to rebill.
const PAYSTACK_INITIALIZE_URL = 'https://api.paystack.co/transaction/initialize';
const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify/';
const DONATION_CURRENCY = 'ZAR';

function validateDonationInitialize(body: DonationInitializeRequest): string | null {
	if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0) {
		return 'Choose a donation amount greater than R0.';
	}
	if (!body.donorName || typeof body.donorName !== 'string' || body.donorName.trim() === '') {
		return 'Please enter your name.';
	}
	if (body.donorName.length > MAX_NAME_LENGTH) {
		return 'That name is too long.';
	}
	if (!body.donorEmail || typeof body.donorEmail !== 'string' || !EMAIL_PATTERN.test(body.donorEmail.trim())) {
		return 'Please enter a valid email address.';
	}
	if (body.donorEmail.length > MAX_EMAIL_LENGTH) {
		return 'That email address is too long.';
	}
	if (body.message != null && typeof body.message !== 'string') {
		return 'That message is not valid.';
	}
	if (typeof body.message === 'string' && body.message.length > MAX_MESSAGE_LENGTH) {
		return 'That message is too long.';
	}
	return null;
}

async function handleDonationInitialize(request: Request, env: Env, origin: string | null): Promise<Response> {
	let body: DonationInitializeRequest;
	try {
		body = (await request.json()) as DonationInitializeRequest;
	} catch {
		return json({ error: 'Invalid JSON body' }, 400, origin);
	}

	const validationError = validateDonationInitialize(body);
	if (validationError) {
		return json({ error: validationError }, 400, origin);
	}

	const donorName = body.donorName.trim();
	const donorEmail = body.donorEmail.trim();
	const message = typeof body.message === 'string' ? body.message.trim() : '';

	try {
		const paystackResponse = await fetch(PAYSTACK_INITIALIZE_URL, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				email: donorEmail,
				amount: Math.round(body.amount * 100),
				currency: DONATION_CURRENCY,
			}),
		});
		const paystackData = (await paystackResponse.json()) as {
			status: boolean;
			message?: string;
			data?: { access_code: string; reference: string };
		};

		if (!paystackResponse.ok || !paystackData.status || !paystackData.data) {
			console.error('Paystack initialize failed:', paystackResponse.status, paystackData.message);
			return json({ error: 'Could not start the donation. Try again.' }, 502, origin);
		}

		const { access_code: accessCode, reference } = paystackData.data;

		const accessToken = await getAccessToken(env);
		await createDocument(env, accessToken, 'donations', reference, {
			amount: doubleValue(body.amount),
			donorName: stringValue(donorName),
			donorEmail: stringValue(donorEmail),
			message: stringValue(message),
			paystackRef: stringValue(reference),
			status: stringValue('pending'),
			createdAt: timestampValue(new Date().toISOString()),
		});

		return json({ ok: true, accessCode, reference }, 200, origin);
	} catch (error) {
		console.error('Donation initialize failed:', error);
		return json({ error: 'Could not start the donation. Try again.' }, 500, origin);
	}
}

function donationSummary(reference: string, donation: Record<string, unknown>, gatewayResponse?: string) {
	return {
		ok: true,
		reference,
		status: typeof donation.status === 'string' ? donation.status : 'pending',
		amount: typeof donation.amount === 'number' ? donation.amount : 0,
		donorName: typeof donation.donorName === 'string' ? donation.donorName : '',
		...(gatewayResponse ? { gatewayResponse } : {}),
	};
}

async function handleDonationVerify(request: Request, env: Env, origin: string | null): Promise<Response> {
	let body: DonationVerifyRequest;
	try {
		body = (await request.json()) as DonationVerifyRequest;
	} catch {
		return json({ error: 'Invalid JSON body' }, 400, origin);
	}

	const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
	if (!reference) {
		return json({ error: 'A payment reference is required.' }, 400, origin);
	}

	try {
		const accessToken = await getAccessToken(env);
		const existingDoc = await getDocument(env, accessToken, 'donations/' + reference);
		if (!existingDoc) {
			return json({ error: 'That donation could not be found.' }, 404, origin);
		}
		const existing = parseFields(existingDoc.fields || {});

		// Already resolved by an earlier call, most likely the visitor
		// reloading the success page. Paystack is not asked again: a
		// completed transaction's status does not change on a second look,
		// and this keeps a page refresh from spending another verify call.
		if (existing.status !== 'pending') {
			return json(donationSummary(reference, existing), 200, origin);
		}

		const verifyResponse = await fetch(PAYSTACK_VERIFY_URL + encodeURIComponent(reference), {
			headers: { Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY },
		});
		const verifyData = (await verifyResponse.json()) as {
			status: boolean;
			message?: string;
			data?: { status: string; gateway_response: string };
		};

		if (!verifyResponse.ok || !verifyData.status || !verifyData.data) {
			console.error('Paystack verify failed:', verifyResponse.status, verifyData.message);
			return json({ error: 'Could not confirm that payment. Try again shortly.' }, 502, origin);
		}

		const resolvedStatus = verifyData.data.status === 'success' ? 'success' : 'failed';
		await updateDocument(env, accessToken, 'donations/' + reference, { status: stringValue(resolvedStatus) }, ['status']);

		return json(donationSummary(reference, { ...existing, status: resolvedStatus }, verifyData.data.gateway_response), 200, origin);
	} catch (error) {
		console.error('Donation verify failed:', error);
		return json({ error: 'Could not confirm that payment. Try again shortly.' }, 500, origin);
	}
}

// --- Admin token verification ---
//
// Checks the Firebase ID token the same way the upload Worker does: RS256
// signature against Google's public keys, then issuer, audience, expiry.
// From there this Worker diverges: rather than a hardcoded ADMIN_UIDS
// secret, it checks the admins/{uid} collection directly, the same source
// of truth every Firestore security rule's isAdmin() already reads.
// Revoking someone is deleting that document, same as everywhere else, no
// second list to keep in sync.
const JWKS_URL = 'https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com';
const JWKS_CACHE_MS = 60 * 60 * 1000;
type SigningKey = JsonWebKey & { kid?: string };
let jwksCache: { keys: SigningKey[]; fetchedAt: number } | null = null;

async function fetchJwks(): Promise<SigningKey[]> {
	if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_MS) {
		return jwksCache.keys;
	}
	const response = await fetch(JWKS_URL);
	if (!response.ok) {
		throw new Error('Could not load the token signing keys: ' + response.status);
	}
	const data = (await response.json()) as { keys: SigningKey[] };
	jwksCache = { keys: data.keys, fetchedAt: Date.now() };
	return data.keys;
}

function decodeBase64Url(part: string): ArrayBuffer {
	const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

function decodeJson(part: string): any {
	try {
		return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
	} catch {
		return null;
	}
}

async function verifyAdmin(request: Request, env: Env): Promise<string | null> {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return null;
	}

	const idToken = authHeader.slice('Bearer '.length);
	const parts = idToken.split('.');
	if (parts.length !== 3) {
		return null;
	}

	const header = decodeJson(parts[0]);
	const payload = decodeJson(parts[1]);
	if (!header || !payload) {
		return null;
	}
	if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
		return null;
	}

	try {
		const keys = await fetchJwks();
		const jwk = keys.find((key) => key.kid === header.kid);
		if (!jwk) {
			return null;
		}

		const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
		const signatureOk = await crypto.subtle.verify(
			'RSASSA-PKCS1-v1_5',
			key,
			decodeBase64Url(parts[2]),
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
		);
		if (!signatureOk) {
			return null;
		}

		if (payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`) {
			return null;
		}
		if (payload.aud !== env.FIREBASE_PROJECT_ID) {
			return null;
		}
		if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
			return null;
		}
		if (typeof payload.sub !== 'string' || payload.sub === '') {
			return null;
		}

		const accessToken = await getAccessToken(env);
		const adminDoc = await getDocument(env, accessToken, 'admins/' + payload.sub);
		return adminDoc ? payload.sub : null;
	} catch (error) {
		console.error('Admin token check failed:', error);
		return null;
	}
}

// --- Admin attendee actions ---
//
// Resend, edit-email and mark-used all need a privileged Firestore write:
// resend and edit-email touch a ticket outside the one transition the
// security rules allow at all (staff redeeming their own scan), and
// mark-used is exactly that transition but done from the admin desk rather
// than the door scanner, so it deliberately does not require the caller to
// also be in the staff collection. All three run with the same
// service-account credential the registration endpoint already uses,
// gated on a verified admin token instead of an open origin check.
async function handleAdminRequest(request: Request, env: Env, origin: string | null, pathname: string): Promise<Response> {
	const adminUid = await verifyAdmin(request, env);
	if (!adminUid) {
		return json({ error: 'Sign in as an admin.' }, 401, origin);
	}

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'Invalid JSON body' }, 400, origin);
	}

	const token = typeof body.token === 'string' ? body.token : '';
	if (!token) {
		return json({ error: 'A ticket token is required.' }, 400, origin);
	}

	try {
		if (pathname === RESEND_PATH) {
			return json(await resendTicketEmail(env, origin, token), 200, origin);
		}
		if (pathname === EDIT_EMAIL_PATH) {
			const newEmail = typeof body.newEmail === 'string' ? body.newEmail.trim() : '';
			if (!EMAIL_PATTERN.test(newEmail) || newEmail.length > MAX_EMAIL_LENGTH) {
				return json({ error: 'Please enter a valid email address.' }, 400, origin);
			}
			return json(await editTicketEmail(env, origin, token, newEmail), 200, origin);
		}
		if (pathname === MARK_USED_PATH) {
			return json(await markTicketUsed(env, token), 200, origin);
		}
	} catch (error) {
		if (error instanceof AdminActionError) {
			return json({ error: error.message }, error.status, origin);
		}
		console.error('Admin attendee action failed:', pathname, error);
		return json({ error: 'That did not work. Try again.' }, 500, origin);
	}

	return json({ error: 'Not found' }, 404, origin);
}

class AdminActionError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

async function getTicketOrThrow(env: Env, accessToken: string, token: string): Promise<Record<string, unknown>> {
	const doc = await getDocument(env, accessToken, 'tickets/' + token);
	if (!doc) {
		throw new AdminActionError('That ticket could not be found.', 404);
	}
	return parseFields(doc.fields || {});
}

async function resendTicketEmail(env: Env, origin: string | null, token: string): Promise<{ ok: true; emailSent: boolean }> {
	const accessToken = await getAccessToken(env);
	const ticket = await getTicketOrThrow(env, accessToken, token);
	const emailSent = await sendConfirmationEmail(env, {
		ticketUrl: origin + '/ticket.html?token=' + encodeURIComponent(token),
		eventTitle: typeof ticket.eventTitle === 'string' ? ticket.eventTitle : 'the event',
		eventStartsAt: typeof ticket.eventStartsAt === 'string' ? ticket.eventStartsAt : null,
		attendeeName: typeof ticket.attendeeName === 'string' ? ticket.attendeeName : '',
		attendeeEmail: typeof ticket.attendeeEmail === 'string' ? ticket.attendeeEmail : '',
		quantity: typeof ticket.quantity === 'number' ? ticket.quantity : 1,
	});
	return { ok: true, emailSent };
}

// The wrong-email case SCHEMA.md calls common: correct the address, then
// resend to the corrected one in the same action, so a mistyped address
// never needs two separate admin steps.
async function editTicketEmail(
	env: Env,
	origin: string | null,
	token: string,
	newEmail: string,
): Promise<{ ok: true; emailSent: boolean }> {
	const accessToken = await getAccessToken(env);
	await getTicketOrThrow(env, accessToken, token);
	await updateDocument(env, accessToken, 'tickets/' + token, { attendeeEmail: stringValue(newEmail) }, ['attendeeEmail']);
	return resendTicketEmail(env, origin, token);
}

async function markTicketUsed(env: Env, token: string): Promise<{ ok: true }> {
	const accessToken = await getAccessToken(env);
	const ticket = await getTicketOrThrow(env, accessToken, token);
	if (ticket.redeemed === true) {
		throw new AdminActionError('This ticket has already been used.', 409);
	}
	await updateDocument(
		env,
		accessToken,
		'tickets/' + token,
		{ redeemed: booleanValue(true), redeemedAt: timestampValue(new Date().toISOString()) },
		['redeemed', 'redeemedAt'],
	);
	return { ok: true };
}

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
// Sent through Brevo's transactional email API. The sender address is the
// shared project Gmail (CONSOLE-STEPS.md: "the shared project account, used
// for Firebase and Cloudflare") rather than the foundation's own domain: a
// single verified sender works immediately with no DNS access, whereas
// sending as info@autismallyship.org needs SPF and DKIM records added to
// their DNS, which is the "verify the sending domain" line in
// CONSOLE-STEPS.md's Still to come. Mail may land in spam until that is
// done. Fine for testing, must be fixed before launch. Must match a sender
// verified in the Brevo account exactly, or Brevo rejects the send outright.
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const SENDER_EMAIL = 'kdmeco.dev@gmail.com';
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

async function sendContactNotifyEmail(env: Env, input: ContactNotifyRequest): Promise<boolean> {
	if (!env.BREVO_API_KEY) {
		return false;
	}

	const toEmail = env.CONTACT_NOTIFY_EMAIL || DEFAULT_CONTACT_NOTIFY_EMAIL;
	const phoneLine = input.phone ? input.phone : 'Not given';

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
				to: [{ email: toEmail }],
				replyTo: { email: input.email, name: input.name },
				subject: 'Contact form: ' + input.category,
				htmlContent: [
					`<p>A message was sent through the website contact form.</p>`,
					`<p><strong>Category:</strong> ${escapeHtml(input.category)}</p>`,
					`<p><strong>Name:</strong> ${escapeHtml(input.name)}</p>`,
					`<p><strong>Email:</strong> ${escapeHtml(input.email)}</p>`,
					`<p><strong>Phone:</strong> ${escapeHtml(phoneLine)}</p>`,
					`<p><strong>Message:</strong></p>`,
					`<p>${escapeHtml(input.message).replace(/\n/g, '<br>')}</p>`,
				].join('\n'),
				textContent: [
					'A message was sent through the website contact form.',
					'Category: ' + input.category,
					'Name: ' + input.name,
					'Email: ' + input.email,
					'Phone: ' + phoneLine,
					'',
					input.message,
				].join('\n'),
			}),
		});
		if (!response.ok) {
			// Status only: the request body holds personal information.
			console.error('Contact notify Brevo send failed:', response.status);
			return false;
		}
		return true;
	} catch (error) {
		const code = error instanceof Error ? error.name : 'unknown';
		console.error('Contact notify Brevo send threw:', code);
		return false;
	}
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
	transactionId?: string,
): Promise<{ fields?: Record<string, unknown> } | null> {
	const url = firestoreBase(env) + '/' + path + (transactionId ? '?transaction=' + encodeURIComponent(transactionId) : '');
	const response = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw new Error('Could not read from Firestore: ' + response.status);
	}
	return (await response.json()) as { fields?: Record<string, unknown> };
}

// A single-document update outside any transaction: resend, edit-email and
// mark-used each touch one ticket in isolation, so the stronger guarantee a
// transaction gives is not needed the way it is for registration racing
// against capacity. updateMask limits the write to exactly the fields
// named, leaving everything else on the document untouched.
async function updateDocument(
	env: Env,
	accessToken: string,
	path: string,
	fields: Record<string, unknown>,
	fieldPaths: string[],
): Promise<void> {
	const mask = fieldPaths.map((field) => 'updateMask.fieldPaths=' + encodeURIComponent(field)).join('&');
	const url = firestoreBase(env) + '/' + path + '?' + mask;
	const response = await fetch(url, {
		method: 'PATCH',
		headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
		body: JSON.stringify({ fields }),
	});
	if (!response.ok) {
		throw new Error('Could not update Firestore: ' + response.status + ' ' + (await response.text()));
	}
}

// Creates a document with a caller-chosen ID outside any transaction, used
// for the donation record so its ID can be the Paystack reference. Fails
// with a 409 if that ID is already taken, which is a free guard against
// ever writing the same donation twice.
async function createDocument(env: Env, accessToken: string, collectionPath: string, documentId: string, fields: Record<string, unknown>): Promise<void> {
	const url = firestoreBase(env) + '/' + collectionPath + '?documentId=' + encodeURIComponent(documentId);
	const response = await fetch(url, {
		method: 'POST',
		headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
		body: JSON.stringify({ fields }),
	});
	if (!response.ok) {
		throw new Error('Could not create the Firestore document: ' + response.status + ' ' + (await response.text()));
	}
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
function doubleValue(value: number) {
	return { doubleValue: value };
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
