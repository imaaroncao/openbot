/**
 * Self-hosted fork: a line at the bottom of the sign-in screen that names the account service used
 * for email sign-in, and a sheet to change it. Scanning the desktop QR code does not need it.
 */

import { useThemeColor } from "heroui-native/hooks";
import { useState } from "react";
import { ActivityIndicator, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  BUNDLED_ACCOUNT_API_URL,
  normalizeSelfHostApiUrl,
  saveSelfHostAccountApiUrl,
  testSelfHostAccountApi,
  useSelfHostServer,
} from "./config";
import { selfHostMessages } from "./messages";

function hostLabel(apiUrl: string | null, unset: string): string {
  if (!apiUrl) return unset;
  try {
    return new URL(apiUrl).host;
  } catch {
    return apiUrl;
  }
}

export function SelfHostServerBadge({ visible }: { visible: boolean }) {
  const insets = useSafeAreaInsets();
  const m = selfHostMessages();
  const [foreground, muted, background, accent, border] = useThemeColor([
    "foreground",
    "muted",
    "background",
    "accent",
    "border",
  ]);
  const override = useSelfHostServer((state) => state.override);
  const current = override ?? BUNDLED_ACCOUNT_API_URL;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!visible) return null;

  const openSheet = () => {
    setDraft(current ?? "");
    setStatus(null);
    setOpen(true);
  };
  const test = async () => {
    const apiUrl = normalizeSelfHostApiUrl(draft);
    if (!apiUrl) {
      setStatus({ ok: false, text: m.invalid });
      return;
    }
    setBusy(true);
    const result = await testSelfHostAccountApi(apiUrl);
    setBusy(false);
    setStatus({ ok: result.ok, text: result.ok ? m.ok : `${m.failed}: ${result.message}` });
  };
  const save = async (value: string | null) => {
    try {
      await saveSelfHostAccountApiUrl(value);
      setOpen(false);
    } catch {
      setStatus({ ok: false, text: m.invalid });
    }
  };
  const button = { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: border };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={m.badgeLabel}
        onPress={openSheet}
        hitSlop={8}
        style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + 10, alignItems: "center" }}
      >
        <Text style={{ color: muted, fontSize: 12 }}>
          {`${m.badge}: ${hostLabel(current, m.badgeUnset)} · `}
          <Text style={{ color: accent }}>{m.badgeChange}</Text>
        </Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#0008" }}>
          <View style={{ backgroundColor: background, borderRadius: 16, padding: 20, gap: 12 }}>
            <Text style={{ color: foreground, fontSize: 17, fontWeight: "600" }}>{m.title}</Text>
            <Text style={{ color: muted, fontSize: 13, lineHeight: 18 }}>{m.hint}</Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={m.placeholder}
              placeholderTextColor={muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={{ color: foreground, borderWidth: 1, borderColor: border, borderRadius: 10, padding: 12 }}
            />
            {BUNDLED_ACCOUNT_API_URL ? (
              <Text style={{ color: muted, fontSize: 12 }}>{`${m.bundled}: ${BUNDLED_ACCOUNT_API_URL}`}</Text>
            ) : null}
            {status ? (
              <Text style={{ color: status.ok ? "#2e9d5b" : "#d2453d", fontSize: 13 }}>{status.text}</Text>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
              <Pressable style={button} onPress={() => void save(null)}>
                <Text style={{ color: foreground }}>{m.reset}</Text>
              </Pressable>
              <Pressable style={button} onPress={() => void test()} disabled={busy}>
                {busy ? <ActivityIndicator /> : <Text style={{ color: foreground }}>{m.test}</Text>}
              </Pressable>
              <Pressable style={button} onPress={() => setOpen(false)}>
                <Text style={{ color: foreground }}>{m.cancel}</Text>
              </Pressable>
              <Pressable
                style={[button, { backgroundColor: accent, borderColor: accent }]}
                onPress={() => void save(draft)}
              >
                <Text style={{ color: "white", fontWeight: "600" }}>{m.save}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
