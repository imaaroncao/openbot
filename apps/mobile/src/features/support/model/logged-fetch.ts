import { fetch as expoFetch } from "expo/fetch";
import { guardVendorFetch } from "@/self-host/network-guard";
import { withRequestLog } from "./support-log";

// Self-hosted fork: `expo/fetch` is native and skips the global fetch guard, so it is wrapped here.
export const fetch = withRequestLog(guardVendorFetch(expoFetch));
