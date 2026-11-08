// Self-hosted fork: a small App Store Connect API client for selfhost/ios/build-testflight.sh.
//
//   node selfhost/ios/asc.mjs prepare   # register the bundle IDs, check that the app record exists
//   node selfhost/ios/asc.mjs builds    # list the latest TestFlight builds of the app
//
// Reads ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH and IOS_BUNDLE_ID from the environment.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, IOS_BUNDLE_ID, IOS_APP_NAME = "OpenBot" } = process.env;
for (const [name, value] of Object.entries({ ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, IOS_BUNDLE_ID })) {
  if (!value) throw new Error(`${name} is required`);
}

function token() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" });
  const payload = encode({ iss: ASC_ISSUER_ID, iat: now, exp: now + 15 * 60, aud: "appstoreconnect-v1" });
  const key = createPrivateKey(readFileSync(ASC_KEY_PATH));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

async function api(method, path, body) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = json?.errors?.map((error) => `${error.code}: ${error.detail ?? error.title}`).join("; ");
    throw new Error(`${method} ${path} → HTTP ${response.status} ${detail ?? text}`);
  }
  return json;
}

const TARGETS = [
  { identifier: IOS_BUNDLE_ID, name: IOS_APP_NAME },
  { identifier: `${IOS_BUNDLE_ID}.ShareExtension`, name: `${IOS_APP_NAME} Share` },
  { identifier: `${IOS_BUNDLE_ID}.ExpoWidgetsTarget`, name: `${IOS_APP_NAME} Widgets` },
  { identifier: `${IOS_BUNDLE_ID}.NotificationService`, name: `${IOS_APP_NAME} Notifications` },
];

async function bundleId(identifier) {
  const found = await api("GET", `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=5`);
  return found.data.find((item) => item.attributes.identifier === identifier) ?? null;
}

async function app() {
  const found = await api("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(IOS_BUNDLE_ID)}&limit=5`);
  return found.data.find((item) => item.attributes.bundleId === IOS_BUNDLE_ID) ?? null;
}

async function prepare() {
  for (const target of TARGETS) {
    const existing = await bundleId(target.identifier);
    if (existing) {
      console.log(`✓ bundle ID ${target.identifier}`);
      continue;
    }
    // Xcode's automatic signing adds the capabilities (App Groups, Push) and the profiles later.
    await api("POST", "/v1/bundleIds", {
      data: { type: "bundleIds", attributes: { identifier: target.identifier, name: target.name, platform: "IOS" } },
    });
    console.log(`+ registered bundle ID ${target.identifier}`);
  }
  const record = await app();
  if (!record) {
    console.log(
      [
        "",
        `✗ App Store Connect has no app for ${IOS_BUNDLE_ID} yet. The API cannot create one; do it once by hand:`,
        "  https://appstoreconnect.apple.com/apps → + → New App",
        `    Platform: iOS · Name: ${IOS_APP_NAME} (any free name) · Primary language: any`,
        `    Bundle ID: ${IOS_BUNDLE_ID} · SKU: ${IOS_BUNDLE_ID.replaceAll(".", "-")} · User access: Full`,
        "  Then run the build again.",
      ].join("\n"),
    );
    process.exit(4);
  }
  console.log(`✓ App Store Connect app "${record.attributes.name}" (${record.id})`);
}

async function builds() {
  const record = await app();
  if (!record) throw new Error(`No app for ${IOS_BUNDLE_ID}`);
  const list = await api("GET", `/v1/builds?filter[app]=${record.id}&sort=-uploadedDate&limit=5`);
  for (const build of list.data) {
    const { version, uploadedDate, processingState } = build.attributes;
    console.log(`${version}\t${processingState}\t${uploadedDate}`);
  }
}

const command = process.argv[2];
if (command === "prepare") await prepare();
else if (command === "builds") await builds();
else throw new Error("usage: asc.mjs prepare|builds");
