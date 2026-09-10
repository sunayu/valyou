/*
 * valyou — on-device social media content filtering.
 * Copyright (C) 2026 Sunayu LLC
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Additional permission under GNU GPL version 3 section 7: this
 * Program may be distributed through the Apple App Store, Google Play,
 * or comparable platforms whose terms would otherwise be incompatible
 * with the GPL. See LICENSE-EXCEPTION.
 */

/**
 * Native settings screen — the mobile analogue of the extension's options page.
 *
 * It edits the same Settings object the engine consumes. Every change is passed
 * up through `onChange`, which the App both persists (encrypted) and pushes into
 * the live WebView via `applySettings` — so toggling a category re-filters the
 * page immediately, with no reload.
 *
 * Kept deliberately small: the extension's options page is the full surface;
 * this covers the switches a phone user reaches for most (master toggle, video
 * policy, per-category action, ML assist). The rest can be added incrementally.
 *
 * ----- HOW THIS SCREEN WORKS (for newcomers) -----
 * This is a "controlled" UI: it does NOT keep its own copy of the settings.
 * Every switch/pill reads its current value straight from the `settings` prop,
 * and every edit calls `onChange` with a brand-new settings object. The parent
 * (App.tsx) owns the state, persists it, and pushes it into the WebView — then
 * passes the updated `settings` back down, which re-renders this screen. So the
 * data flows down as props and changes flow up as callbacks.
 */
import React from "react";
// React Native UI pieces. <ScrollView> scrolls its contents; <Switch> is a
// native on/off toggle.
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  Switch,
  TouchableOpacity,
  StyleSheet,
  PanResponder,
  DimensionValue,
} from "react-native";
// Import the Settings TYPE only (used for prop typing; erased at runtime).
import { Settings } from "./storage";

// The props this component accepts. `onChange`/`onClose` are functions the
// parent passes in; `(next: Settings) => void` means "a function taking a
// Settings and returning nothing".
interface Props {
  settings: Settings; // current settings to display
  onChange: (next: Settings) => void; // called with an updated copy on any edit
  onClose: () => void; // called when the user taps Done
}

/** Human-readable labels for the engine's internal category ids. */
const CATEGORY_LABELS: Record<string, string> = {
  hate_racial: "Racial hate",
  hate_gender: "Sexist / gendered hate",
  violence: "Violence & threats",
  harassment: "Harassment",
  rage_bait: "Rage bait",
};

/** The video policy choices, in escalating strictness. */
const VIDEO_MODES: { key: Settings["media"]["video"]; label: string; hint: string }[] = [
  { key: "allow", label: "Allow", hint: "Videos play normally" },
  { key: "block", label: "Tag + no autoplay", hint: "Video posts get a tag; nothing autoplays on its own" },
  { key: "hide", label: "Swipe to play", hint: "Videos are covered until you swipe right" },
];

/** The per-category action choices. */
const ACTIONS: { key: string; label: string }[] = [
  { key: "hide", label: "Hide" },
  { key: "blur", label: "Blur" },
  { key: "tag", label: "Tag" },
  { key: "off", label: "Off" },
];

// Sensitivity <-> threshold. The engine works in "threshold" (0.2 = filters a
// lot, 0.95 = filters little); users think in "sensitivity" (drag right = more
// filtering). So sensitivity is the INVERSE of threshold over this range.
const T_MIN = 0.2;
const T_MAX = 0.95;
function toSensitivity(threshold: number): number {
  const s = (T_MAX - threshold) / (T_MAX - T_MIN);
  return Math.max(0, Math.min(1, s));
}
function toThreshold(sensitivity: number): number {
  const th = T_MAX - sensitivity * (T_MAX - T_MIN);
  return Math.round(th * 100) / 100; // keep 2 decimals
}

/**
 * A lightweight touch slider (0..1), built from Views + PanResponder so it needs
 * no native dependency. Drag anywhere on the track to set the value.
 */
function SensitivitySlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}): React.ReactElement {
  // widthRef holds the measured track width; cbRef always points at the latest
  // onChange so the once-created PanResponder calls the current handler.
  const widthRef = React.useRef(1);
  const cbRef = React.useRef(onChange);
  cbRef.current = onChange;

  const responder = React.useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => setFromX(e.nativeEvent.locationX),
      onPanResponderMove: (e) => setFromX(e.nativeEvent.locationX),
    })
  ).current;

  function setFromX(x: number): void {
    const w = widthRef.current || 1;
    cbRef.current(Math.max(0, Math.min(1, x / w)));
  }

  const pct = `${Math.round(value * 100)}%` as DimensionValue;
  return (
    <View
      style={styles.track}
      onLayout={(e) => (widthRef.current = e.nativeEvent.layout.width)}
      {...responder.panHandlers}
    >
      <View style={styles.trackBase} />
      <View style={[styles.trackFill, { width: pct }]} />
      <View style={[styles.thumb, { left: pct }]} />
    </View>
  );
}

// `{ settings, onChange, onClose }: Props` is destructuring: it pulls those
// three fields out of the props object into local variables in one step.
export default function SettingsScreen({ settings, onChange, onClose }: Props): React.ReactElement {
  /**
   * Make an edit without mutating the current settings in place (React state
   * must be treated as immutable). We deep-clone into `draft`, let the caller's
   * `mutator` change the draft, then hand the new object up via onChange. Each
   * caller below just writes e.g. `(d) => (d.enabled = v)`.
   */
  function patch(mutator: (draft: Settings) => void): void {
    const draft: Settings = JSON.parse(JSON.stringify(settings)); // deep clone
    mutator(draft); // apply the caller's change to the copy
    onChange(draft); // send the updated copy up to the parent
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>valyou</Text>
        <TouchableOpacity onPress={onClose} accessibilityLabel="Close settings">
          <Text style={styles.done}>Done</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Master on/off. The Switch's `value` reads from settings; toggling it
            fires onValueChange with the new boolean `v`, which patch writes into
            a fresh copy. Row/Choice/Section are small helper components below. */}
        <Row
          label="Filtering"
          hint="Master switch for all protection"
          right={
            <Switch value={settings.enabled} onValueChange={(v) => patch((d) => (d.enabled = v))} />
          }
        />

        <Section title="Video" />
        {/* One selectable Choice per video mode; the selected one is the mode
            matching the current setting. */}
        {VIDEO_MODES.map((m) => (
          <Choice
            key={m.key}
            label={m.label}
            hint={m.hint}
            selected={settings.media.video === m.key}
            onPress={() => patch((d) => (d.media.video = m.key))}
          />
        ))}
        <Row
          label="Blur flagged videos"
          hint="Extra blur on videos in flagged posts"
          right={
            <Switch
              value={settings.media.flaggedVideoBlur}
              onValueChange={(v) => patch((d) => (d.media.flaggedVideoBlur = v))}
            />
          }
        />

        <Section title="Categories" />
        {/* For each category, render its label and a row of action pills. The
            selected pill is the one whose key equals this category's action.
            Falls back to the raw id if no friendly label exists. */}
        {Object.keys(settings.categories).map((id) => (
          <View key={id} style={styles.catBlock}>
            <Text style={styles.catLabel}>{CATEGORY_LABELS[id] || id}</Text>
            <View style={styles.actions}>
              {ACTIONS.map((a) => (
                <TouchableOpacity
                  key={a.key}
                  style={[styles.pill, settings.categories[id].action === a.key && styles.pillActive]}
                  onPress={() => patch((d) => (d.categories[id].action = a.key))}
                >
                  <Text
                    style={[
                      styles.pillText,
                      settings.categories[id].action === a.key && styles.pillTextActive,
                    ]}
                  >
                    {a.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {/* Sensitivity slider: drag right to filter more (a lower internal
                threshold). Only meaningful when the category isn't "Off". */}
            <View style={styles.sensRow}>
              <Text style={styles.sensEnd}>Less</Text>
              <View style={styles.sensSliderWrap}>
                <SensitivitySlider
                  value={toSensitivity(settings.categories[id].threshold)}
                  onChange={(s) =>
                    patch((d) => (d.categories[id].threshold = toThreshold(s)))
                  }
                />
              </View>
              <Text style={styles.sensEnd}>More</Text>
            </View>
          </View>
        ))}

        <Section title="Detection" />
        <Row
          label="On-device ML assist"
          hint="Bundled model, nothing leaves your phone"
          right={
            <Switch
              value={settings.ml.enabled}
              onValueChange={(v) => patch((d) => (d.ml.enabled = v))}
            />
          }
        />

        <Text style={styles.footer}>
          All filtering runs on your device. No content, browsing, or account data ever leaves your
          phone.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * A labelled row with an arbitrary control on the right (a Switch here).
 * `right: React.ReactNode` means it accepts any renderable element. `hint?`
 * is optional; the `hint ? <Text> : null` renders it only when provided.
 */
function Row({ label, hint, right }: { label: string; hint?: string; right: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      {right}
    </View>
  );
}

/**
 * A single-select choice row (radio-like): tapping it calls `onPress`, and a
 * filled/empty dot on the right reflects `selected`. Used for the video modes.
 */
function Choice({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Text style={[styles.radio, selected && styles.radioOn]}>{selected ? "●" : "○"}</Text>
    </TouchableOpacity>
  );
}

/** A small uppercase section header used to group the rows above. */
function Section({ title }: { title: string }) {
  return <Text style={styles.section}>{title.toUpperCase()}</Text>;
}

// Visual styles for this screen (see the StyleSheet note in App.tsx).
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0e1015" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    height: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#242833",
  },
  title: { color: "#fff", fontSize: 20, fontWeight: "700" },
  done: { color: "#2f6feb", fontSize: 16, fontWeight: "600" },
  body: { padding: 16, paddingBottom: 48 },
  section: { color: "#6b7280", fontSize: 12, fontWeight: "700", marginTop: 24, marginBottom: 8, letterSpacing: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1c1f27",
  },
  rowText: { flex: 1, paddingRight: 12 },
  rowLabel: { color: "#e9ecf2", fontSize: 16 },
  rowHint: { color: "#7b8494", fontSize: 12, marginTop: 2 },
  radio: { color: "#3a4150", fontSize: 18 },
  radioOn: { color: "#2f6feb" },
  catBlock: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#1c1f27" },
  catLabel: { color: "#e9ecf2", fontSize: 16, marginBottom: 10 },
  actions: { flexDirection: "row", gap: 8 },
  pill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, backgroundColor: "#1c1f27" },
  pillActive: { backgroundColor: "#2f6feb" },
  pillText: { color: "#98a0ad", fontWeight: "600", fontSize: 13 },
  pillTextActive: { color: "#fff" },
  // sensitivity slider
  sensRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14 },
  sensEnd: { color: "#6b7280", fontSize: 11, width: 34, textAlign: "center" },
  sensSliderWrap: { flex: 1 },
  track: { height: 34, justifyContent: "center" }, // tall touch target; visuals centered
  trackBase: { position: "absolute", left: 0, right: 0, height: 6, borderRadius: 999, backgroundColor: "#1c1f27" },
  trackFill: { position: "absolute", left: 0, height: 6, borderRadius: 999, backgroundColor: "#2f6feb" },
  thumb: {
    position: "absolute", width: 22, height: 22, borderRadius: 999, marginLeft: -11,
    backgroundColor: "#fff", borderWidth: 2, borderColor: "#2f6feb",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
  },
  footer: { color: "#6b7280", fontSize: 12, marginTop: 28, lineHeight: 18 },
});
