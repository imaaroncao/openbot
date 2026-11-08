// Self-hosted fork: signs in to the local test account service and prints a host ticket and a
// client ticket for one remote session, as the desktop host and a phone get them.
//   node local-e2e-tickets.mjs <api origin>   (env: CURL_RESOLVE=host:443:ip, NODE_EXTRA_CA_CERTS)
import { randomUUID } from "node:crypto";

const api = process.argv[2];
async function call(path, { token, body, headers = {} } = {}) {
  const response = await fetch(new URL(path, api), {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${JSON.stringify(json)}`);
  return json;
}

const email = `e2e-${Date.now()}@example.test`;
const start = await call("/v1/auth/email/start", { body: { email }, headers: { "Idempotency-Key": randomUUID() } });
const verify = await call("/v1/auth/email/verify", {
  body: { challengeId: start.challengeId, code: start.developmentCode, deviceName: "local e2e" },
});
const token = verify.sessionToken;
const me = await call("/v1/me", { token });
const hostId = randomUUID();
const host = await call("/v2/remote/hosts/register", {
  token,
  body: { hostId, name: "local e2e host", ownerMembershipId: randomUUID(), rotateCredential: true },
});
const hostTicket = await call(`/v2/remote/hosts/${hostId}/ticket`, {
  body: { machineToken: host.machineToken, signalHome: false },
});
const session = await call("/v2/remote/sessions/", { token, body: { hostId } });
const sessionId = session.sessionId ?? session.id ?? session.session?.id;
const clientTicket = await call(`/v2/remote/sessions/${sessionId}/ticket`, {
  token,
  body: { clientPublicKey: `e2e-${randomUUID()}` },
});
console.error(`signed in as ${me.email}; host ${hostId}; session ${sessionId}; signal ${hostTicket.signalUrl}`);
console.log(`OPENBOT_REMOTE_SIGNAL_URL=${hostTicket.signalUrl}`);
console.log(`OPENBOT_REMOTE_SMOKE_HOST_TICKET=${hostTicket.ticket}`);
console.log(`OPENBOT_REMOTE_SMOKE_CLIENT_TICKET=${clientTicket.ticket}`);
