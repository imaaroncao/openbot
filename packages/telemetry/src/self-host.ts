/**
 * Self-hosted fork: the single switch for vendor product analytics and error reports.
 *
 * Every surface (desktop main process, desktop renderer, mobile) checks it where its analytics
 * and report queues start, and the OpenPanel transport refuses to send while it is false. It is
 * typed `boolean`, not `false`, so the guarded upstream code still type-checks unchanged.
 */
export const vendorTelemetryEnabled: boolean = false;
