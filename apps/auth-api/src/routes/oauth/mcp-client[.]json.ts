import { createFileRoute } from "@tanstack/solid-router";

/**
 * OpenBot's OAuth client metadata document (CIMD, SEP-991). An MCP authorization server with no
 * client registration, such as ElevenLabs, reads it when OpenBot sends this URL as its `client_id`.
 * `MCP_CLIENT_METADATA_URL` in `src/backend/mcp-oauth-provider.ts` sends it. The redirect addresses
 * are the loopback listener of `src/main/mcp-oauth-redirect-server.ts` and its `openbot://` fallback.
 */
// Self-hosted fork: the document names the server that serves it, so a self-hosted account service
// is the client ID, and the vendor's site is not in the sign-in.
function mcpClientMetadataResponse({ request }: { request: Request }): Response {
  const origin = new URL(request.url).origin;
  return Response.json(
    {
      client_id: `${origin}/oauth/mcp-client.json`,
      client_name: "OpenBot",
      client_uri: origin,
      logo_uri: `${origin}/icon-512x512.png`,
      redirect_uris: ["http://127.0.0.1:28417/mcp-auth", "openbot://mcp-auth"],
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } },
  );
}

export const Route = createFileRoute("/oauth/mcp-client.json")({
  server: { handlers: { GET: mcpClientMetadataResponse } },
});
