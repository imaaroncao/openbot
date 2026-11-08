import { AGENT_PROVIDERS, type AgentProviderId } from "@openbot/contracts/agent-providers";
import { isSelfHostRemovedProvider, SELF_HOST_REMOVED_PROVIDERS } from "@openbot/contracts/self-host-providers";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

const ProviderUseFile = Schema.Struct({
  version: Schema.Literal(1),
  off: Schema.Array(Schema.Literals(AGENT_PROVIDERS.filter((provider) => provider !== "acp"))),
});
const decodeProviderUseFile = Schema.decodeUnknownResult(ProviderUseFile);

/** Owns the local provider switches. Unknown files stay unchanged. */
export class ProviderUseSettingsStore {
  readonly #path: string;
  readonly #writes = Semaphore.makeUnsafe(1);
  #off: AgentProviderId[] = [];
  #readOnly = false;

  constructor(path: string) {
    this.#path = path;
  }

  readonly load = Effect.fn("ProviderUseSettings.load")(function* (this: ProviderUseSettingsStore) {
    const result = yield* Effect.result(
      readPreferenceFile(this.#path, (value) => {
        const decoded = decodeProviderUseFile(value);
        return Result.isSuccess(decoded) ? [...decoded.success.off] : null;
      }),
    );
    if (Result.isFailure(result)) {
      if (isMissingFileError(result.failure.cause)) return;
      if (!(result.failure.cause instanceof SyntaxError)) return yield* result.failure;
    } else if (result.success) {
      this.#off = result.success;
      return;
    }
    this.#readOnly = true;
  }).bind(this);

  off(): readonly AgentProviderId[] {
    // Self-hosted fork: a removed provider is always off.
    return [...new Set([...this.#off, ...SELF_HOST_REMOVED_PROVIDERS])];
  }

  readonly set = Effect.fn("ProviderUseSettings.set")(function* (
    this: ProviderUseSettingsStore,
    provider: AgentProviderId,
    on: boolean,
  ) {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        // Self-hosted fork: a removed provider cannot be turned on.
        if (on && isSelfHostRemovedProvider(provider))
          return yield* new PreferenceFileFailure({ cause: new Error(`${provider} is removed in this build.`) });
        if (this.#readOnly)
          return yield* new PreferenceFileFailure({
            cause: new Error(sourceText("error.provider.useSettingsReadOnly")),
          });
        const off = this.#off.filter((id) => id !== provider);
        if (!on) off.push(provider);
        yield* writePreferenceFile(this.#path, { version: 1, off }, { createDirectory: true });
        this.#off = off;
      }).pipe(Effect.uninterruptible),
    );
  }).bind(this);
}
