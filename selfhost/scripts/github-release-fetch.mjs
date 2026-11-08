// Self-hosted fork: a Bun preload (BUN_OPTIONS=--preload=…) set by github-release-proxy.sh. It
// sends `fetch` calls to GitHub release downloads through github-release-proxy.mjs at
// GITHUB_RELEASE_PROXY, and `github.com/<owner>/<repo>/raw/<ref>/<path>` (which also fails) straight to
// raw.githubusercontent.com, where github.com redirects it. All other requests are not changed.
const proxy = process.env.GITHUB_RELEASE_PROXY;
const originalFetch = globalThis.fetch;
const releaseDownload = /^https:\/\/github\.com\/(?=[^/]+\/[^/]+\/releases\/download\/)/u;
const rawFile = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/raw\//u;

if (proxy) {
  globalThis.fetch = Object.assign((input, init) => {
    if (typeof input === "string" || input instanceof URL) {
      const url = String(input);
      if (releaseDownload.test(url)) return originalFetch(url.replace(releaseDownload, `${proxy}/`), init);
      if (rawFile.test(url)) return originalFetch(url.replace(rawFile, "https://raw.githubusercontent.com/$1/"), init);
    }
    return originalFetch(input, init);
  }, originalFetch);
}
