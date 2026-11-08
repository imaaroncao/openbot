import { fetch as expoFetch } from "expo/fetch";
import { guardVendorFetch } from "@/self-host/network-guard";
import { withRequestLog } from "./support-log";

/** `expo/fetch` with a support log line for each request. Import it instead of `expo/fetch`. */
// Self-hosted fork: `expo/fetch` is native and skips the global fetch guard, so it is wrapped here.
export const fetch = withRequestLog(guardVendorFetch(expoFetch));
