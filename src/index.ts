export default {
	async fetch(request, env, ctx): Promise<Response> {
		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
