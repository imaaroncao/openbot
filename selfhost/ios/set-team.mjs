// Self-hosted fork: gives every target of the prebuilt Xcode project the signing team.
// Expo's `ios.appleTeamId` sets it only on the targets that Expo knows; the share extension that
// expo-sharing adds has none, and Xcode's automatic signing then does not register its App Group.
//   node selfhost/ios/set-team.mjs apps/mobile/ios/OpenBot.xcodeproj/project.pbxproj HUHQBLKUWS
import { readFileSync, writeFileSync } from "node:fs";

const [path, team] = process.argv.slice(2);
if (!path || !/^[A-Z0-9]{10}$/u.test(team ?? "")) throw new Error("usage: set-team.mjs <project.pbxproj> <TEAMID>");
let added = 0;
const project = readFileSync(path, "utf8").replace(/buildSettings = \{([^}]*)\};/gu, (block, body) => {
  if (!body.includes("PRODUCT_BUNDLE_IDENTIFIER") || body.includes("DEVELOPMENT_TEAM")) return block;
  added += 1;
  const indent = body.match(/\n(\s*)\S/u)?.[1] ?? "\t\t\t\t";
  return `buildSettings = {\n${indent}DEVELOPMENT_TEAM = ${team};${body}};`;
});
writeFileSync(path, project);
console.log(`  DEVELOPMENT_TEAM ${team} added to ${added} build configurations`);
