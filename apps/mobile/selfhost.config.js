// Self-hosted fork: turns the upstream Expo config into a build for your own Apple team.
//
// `app.config.js` calls this last, so `app.json` stays as upstream ships it and merges stay clean.
// Every value comes from the environment, which `selfhost/ios/build-testflight.sh` loads from
// `selfhost/selfhost.env`. Without OPENBOT_IOS_BUNDLE_ID the upstream config is returned unchanged
// (apart from OTA updates, which are always off).
//
//   OPENBOT_IOS_BUNDLE_ID     com.example.openbot        replaces run.openbot.mobile everywhere,
//                                                       including extensions and the App Group
//   OPENBOT_APPLE_TEAM_ID     ABCDE12345                 signing team of every target
//   OPENBOT_IOS_APP_NAME      OpenBot                    name under the icon
//   OPENBOT_IOS_BUILD_NUMBER  202611081230               CFBundleVersion; each upload needs a new one
//   EXPO_PUBLIC_OPENBOT_API_URL https://api.example.com  account service for email sign-in

const UPSTREAM_BUNDLE_ID = "run.openbot.mobile";

/** @param {unknown} value @param {(text: string) => string} change @returns {any} */
function mapStrings(value, change) {
  if (typeof value === "string") return change(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, change)]));
  }
  return value;
}

/** @param {import('expo/config').ExpoConfig} config @returns {import('expo/config').ExpoConfig} */
module.exports = function applySelfHost(config) {
  const bundleId = process.env.OPENBOT_IOS_BUNDLE_ID?.trim();
  const teamId = process.env.OPENBOT_APPLE_TEAM_ID?.trim();
  const appName = process.env.OPENBOT_IOS_APP_NAME?.trim();
  const buildNumber = process.env.OPENBOT_IOS_BUILD_NUMBER?.trim();

  // Expo over-the-air updates come from the vendor's EAS project: never check them.
  let next = {
    ...config,
    updates: { ...config.updates, enabled: false, checkAutomatically: "NEVER", url: undefined },
  };
  if (!bundleId) return next;
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/u.test(bundleId)) {
    throw new Error(`OPENBOT_IOS_BUNDLE_ID is not a bundle identifier: ${bundleId}`);
  }

  next = mapStrings(next, (text) => text.split(UPSTREAM_BUNDLE_ID).join(bundleId));
  const { associatedDomains: _vendorDomains, ...ios } = next.ios ?? {};
  next.ios = {
    ...ios,
    bundleIdentifier: bundleId,
    ...(teamId ? { appleTeamId: teamId } : {}),
    ...(buildNumber ? { buildNumber } : {}),
    infoPlist: { ...ios.infoPlist, ITSAppUsesNonExemptEncryption: false },
  };
  if (appName) next.name = appName;
  // The vendor's EAS project and owner: a local build does not use EAS.
  const { eas: _vendorEas, ...extra } = next.extra ?? {};
  next.extra = extra;
  delete next.owner;
  return next;
};
