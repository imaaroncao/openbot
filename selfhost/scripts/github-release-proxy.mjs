// Self-hosted fork: a local stand-in for https://github.com/<owner>/<repo>/releases/download/<tag>/<name>,
// started by github-release-proxy.sh for the DMG and Linux builds. It finds the asset through the
// GitHub API and redirects to its signed download URL. The release download path of github.com can
// fail for hours with HTTP 504 while the API works. The build scripts still check every download.
//
//   node github-release-proxy.mjs [port] [port-file]     (port 0 = any free port; 127.0.0.1 only)
//
// GITHUB_TOKEN, when set, raises the API limit of 60 requests an hour.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 0);
const portFile = process.argv[3];
const headers = {
  "user-agent": "openbot-selfhost-build",
  "x-github-api-version": "2022-11-28",
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};
const releases = new Map();

function release(owner, repo, tag) {
  const key = `${owner}/${repo}@${tag}`;
  if (!releases.has(key)) {
    const lookup = fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
      headers,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`${key}: GitHub API HTTP ${response.status}`);
      return response.json();
    });
    releases.set(key, lookup);
    lookup.catch(() => releases.delete(key));
  }
  return releases.get(key);
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const match = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/u.exec(path);
  if (!match) return response.writeHead(404).end();
  const [owner, repo, tag, name] = match.slice(1).map(decodeURIComponent);
  try {
    const asset = (await release(owner, repo, tag)).assets.find((candidate) => candidate.name === name);
    if (!asset) return response.writeHead(404).end();
    const redirect = await fetch(asset.url, {
      headers: { ...headers, accept: "application/octet-stream" },
      redirect: "manual",
    });
    const location = redirect.headers.get("location");
    if (!location) throw new Error(`${owner}/${repo}@${tag}/${name}: GitHub API HTTP ${redirect.status}`);
    console.log(`github-release-proxy: ${owner}/${repo}@${tag}/${name}`);
    response.writeHead(302, { location }).end();
  } catch (error) {
    console.error(`github-release-proxy: ${error instanceof Error ? error.message : error}`);
    response.writeHead(502).end();
  }
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const listening = typeof address === "object" && address ? address.port : port;
  if (portFile) writeFileSync(portFile, `${listening}\n`);
  console.log(`github-release-proxy: listening on 127.0.0.1:${listening}`);
});
