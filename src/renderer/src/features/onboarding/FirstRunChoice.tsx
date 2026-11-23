import { ProviderLogo, type ProviderLogoVariant } from "@openbot/brand";
import { isSelfHostRemovedProvider } from "@openbot/contracts/self-host-providers";
import { vendorTelemetryEnabled } from "@openbot/telemetry/self-host";
import { Button, ChevronRight, Spinner } from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { useText } from "@openbot/ui/text";
import { createUniqueId, For, Show } from "solid-js";
import { AnalyticsConsentRow, ConsentNotice } from "./AnalyticsConsent";
import type { OnboardingAvatarVariant } from "./onboarding-avatars";
import { FREE_PROVIDER } from "./onboarding-provider-rows";

export interface FirstRunChoiceProps {
  team: readonly OnboardingAvatarVariant[];
  disabled: boolean;
  loading: boolean;
  reason: string;
  onStartFree: () => void;
  onUsePlan: () => void;
  analytics: boolean;
  onAnalyticsChange: (enabled: boolean) => void;
  onOpenTerms: () => void;
  onOpenPrivacy: () => void;
}

const PLAN_LOGOS: readonly ProviderLogoVariant[] = ["codex", "claude", "grok"];

export function FirstRunChoice(props: FirstRunChoiceProps) {
  const { t } = useText();
  const reasonId = createUniqueId();
  const freeDetailId = createUniqueId();
  const planDetailId = createUniqueId();
  const freeDescribedBy = () => (props.reason ? `${freeDetailId} ${reasonId}` : freeDetailId);
  return (
    <>
      <h1 id="onboarding-title" class="first-run-choice-title">
        {t("onboarding.choice.title")}
      </h1>
      <p class="onboarding-description">{t("onboarding.choice.description")}</p>
      <div class="first-run-choice-rows">
        {/* Self-hosted fork: no free-models row when its provider is removed. */}
        <Show when={!isSelfHostRemovedProvider(FREE_PROVIDER)}>
          <Button
            type="button"
            variant="ghost"
            class="first-run-choice-row"
            disabled={props.disabled || props.loading}
            aria-busy={props.loading ? "true" : undefined}
            aria-label={t("onboarding.choice.startFree")}
            aria-describedby={freeDescribedBy()}
            onClick={() => props.onStartFree()}
          >
            <span class="first-run-choice-row-text">
              <strong>{t("onboarding.choice.startFree")}</strong>
              <span id={freeDetailId}>{t("onboarding.choice.freeDetail")}</span>
            </span>
            <Show
              when={props.loading}
              fallback={<ChevronRight class="first-run-choice-row-chevron" aria-hidden="true" />}
            >
              <Spinner size="sm" label={t("onboarding.opening")} />
            </Show>
          </Button>
        </Show>
        <Button
          type="button"
          variant="ghost"
          class="first-run-choice-row"
          disabled={props.disabled}
          aria-label={t("onboarding.choice.subscription")}
          aria-describedby={planDetailId}
          onClick={() => props.onUsePlan()}
        >
          <span class="first-run-choice-row-text">
            <strong>{t("onboarding.choice.subscription")}</strong>
            <span id={planDetailId}>{t("onboarding.choice.subscriptionDetail")}</span>
          </span>
          <span class="first-run-choice-logos" aria-hidden="true">
            <For each={PLAN_LOGOS}>
              {(provider) => <ProviderLogo provider={provider} class="first-run-choice-logo" />}
            </For>
          </span>
          <ChevronRight class="first-run-choice-row-chevron" aria-hidden="true" />
        </Button>
        {/* Self-hosted fork: no product analytics are sent, so the opt-in is not shown. */}
        <Show when={vendorTelemetryEnabled}>
          <AnalyticsConsentRow
            checked={props.analytics}
            disabled={props.disabled}
            agents={props.team.slice(2, 5)}
            onChange={(enabled) => props.onAnalyticsChange(enabled)}
          />
        </Show>
      </div>
      <ConsentNotice onOpenTerms={() => props.onOpenTerms()} onOpenPrivacy={() => props.onOpenPrivacy()} />
      <Show when={props.reason}>
        {(reason) => (
          <p class="onboarding-next-reason first-run-choice-reason" id={reasonId}>
            {reason()}
          </p>
        )}
      </Show>
    </>
  );
}

export function FirstRunTeam(props: { team: readonly OnboardingAvatarVariant[] }) {
  return (
    <div class="first-run-choice-team" aria-hidden="true">
      <For each={props.team}>
        {(member) => (
          <AgentAvatar
            seed={member.seed}
            hue={member.hue}
            motion="idle"
            animationOffset={member.animationOffset}
            followPointer
            class="first-run-choice-avatar"
          />
        )}
      </For>
    </div>
  );
}
