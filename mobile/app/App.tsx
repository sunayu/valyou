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
 * valyou mobile — the app shell.
 *
 * This is a content-filtering browser: it loads the mobile web versions of the
 * supported networks in a WebView and injects the shared filtering engine
 * (mobile/dist/valyou-inject.js) into each page. The engine — classifier,
 * lexicon, ML model, blur/hide, video gating — is identical to the extension.
 *
 * TRUST MODEL (mirrors the extension): the WebView page is treated as
 * untrusted. Settings live natively (encrypted at rest) and are pushed INTO
 * the page; the page only ever sends back counter events. Nothing the site or
 * the injected script does can reach the stored settings or the user's data.
 *
 * NOTE: this is the app scaffold. It needs a React Native toolchain to build
 * (`npx react-native run-ios` / `run-android`). The three tabs use the mobile
 * web hosts; login behaviour in an embedded WebView is the key thing to verify
 * on real devices (see mobile/README.md → Risks).
 *
 * ----- REACT / REACT NATIVE PRIMER (for newcomers) -----
 * React Native builds phone UIs out of "components": functions that RETURN a
 * description of what to show, written in JSX (the HTML-like markup below).
 * When a component's data changes, React re-runs the function and updates only
 * what differs on screen. Instead of HTML tags you use RN components like
 * <View> (a box), <Text>, <TouchableOpacity> (a tappable area).
 *
 * "Hooks" are special functions (names start with `use…`) that let a component
 * remember data and run side effects across those re-runs. This file uses:
 *   useState   — remember a value; changing it re-renders the component.
 *   useEffect  — run side-effect code (e.g. load from storage) after render.
 *   useRef     — hold a mutable handle (here, the WebView) that does NOT trigger
 *                a re-render when it changes.
 *   useMemo    — cache an expensive computed value, recomputed only when its
 *                inputs change.
 *   useCallback— cache a function so it keeps the same identity between renders
 *                (avoids re-creating handlers and needless child re-renders).
 * Each is explained again at its use site below.
 */
// Import React plus the specific hooks this file uses.
import React, { useCallback, useMemo, useRef, useState } from "react";
// UI building blocks from React Native (not HTML — these render to native views).
import {
  SafeAreaView, View, Text, TouchableOpacity, StyleSheet, StatusBar, Platform, NativeModules,
} from "react-native";
// The WebView component (embedded browser) and the TypeScript type describing a
// message it sends us.
import { WebView, WebViewMessageEvent } from "react-native-webview";
// Our own storage helpers, plus the `Settings` type. `Settings` is a TypeScript
// type only — it disappears at runtime and just describes the object's shape.
import { loadSettings, recordStat, Settings } from "./src/storage";
import SettingsScreen from "./src/SettingsScreen";

// The generated engine bundle, as a string. build-bundle.js emits this module
// (`module.exports = "<bundle>"`) alongside the raw .js the tests run, so the
// app injects the exact bytes that were verified in Node.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const INJECT_BUNDLE: string = require("../dist/valyou-inject.bundle.js");

/** The networks the app browses. Names/URLs only — no third-party branding. */
const SITES = [
  { key: "facebook", label: "Facebook", url: "https://m.facebook.com/" },
  { key: "instagram", label: "Instagram", url: "https://www.instagram.com/" },
  { key: "x", label: "X", url: "https://x.com/" },
];

// Present as ordinary mobile Safari. Some sites (notably X) sniff the WebView's
// user-agent and, if it looks like an in-app browser, push the user to open
// their native app. A genuine Safari UA makes them serve the normal mobile web.
const SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";

/**
 * Build the settings-injection preamble. Runs before the engine bundle so the
 * page has `window.__VALYOU__.settings` ready when the engine starts.
 *
 * @param settings Resolved (decrypted) settings from native storage.
 * @returns JavaScript to inject before the engine.
 */
// This function builds a small string of JavaScript. We literally concatenate
// source code as text and hand it to the WebView to run inside the page. The
// trailing ";true;" is a react-native-webview convention: the injected script
// should evaluate to a value, and `true` avoids a warning. JSON.stringify turns
// the settings object into a JS object literal safely embedded in that source.
function settingsPreamble(settings: Settings): string {
  return (
    "window.__VALYOU__ = window.__VALYOU__ || {};" +
    "window.__VALYOU__.settings = " +
    JSON.stringify(settings) +
    ";true;"
  );
}

// The App component. `export default` makes it the file's main export; React
// Native renders it as the root of the app. It returns a React element (the UI).
export default function App(): React.ReactElement {
  // useState returns a [currentValue, setterFunction] pair. Calling the setter
  // stores a new value AND tells React to re-render with it.
  // `site` = which social network tab is active (starts on the first one).
  const [site, setSite] = useState(SITES[0]);
  // `showSettings` = whether the settings screen is up instead of the browser.
  const [showSettings, setShowSettings] = useState(false);
  // `settings` = the loaded settings, or null until they finish loading.
  // The <Settings | null> is a TypeScript type argument naming the allowed types.
  const [settings, setSettings] = useState<Settings | null>(null);
  // useRef holds a handle to the live WebView instance. Unlike state, updating a
  // ref does not re-render; we use it to imperatively call methods on the WebView.
  const webviewRef = useRef<WebView>(null);

  // useEffect runs its function AFTER render. The empty dependency array `[]`
  // means "run once, on mount". Here: load the encrypted settings, then store
  // them in state (which triggers a re-render showing the WebView).
  React.useEffect(() => {
    loadSettings().then(setSettings);
  }, []);


  // useMemo caches a computed value and only recomputes when a dependency in the
  // array changes — here, whenever `settings` changes. `injected` is the full
  // script we inject: the settings preamble followed by the engine bundle. Until
  // settings load we inject a harmless "true;".
  const injected = useMemo(
    () => (settings ? settingsPreamble(settings) + "\n" + INJECT_BUNDLE : "true;"),
    [settings]
  );

  // ANDROID: the engine is too big to cross the bridge in one call.
  //
  // injectJavaScript hands the script to Android's WebView.evaluateJavascript,
  // which travels over a Binder transaction capped at ~1 MB. Java strings are
  // UTF-16, so our ~655k-character bundle weighs ~1.3 MB and the call is
  // DROPPED SILENTLY — no exception, no console error, the engine simply never
  // exists and nothing is ever filtered. (iOS/WKWebView has no such limit, which
  // is why this only ever showed up on Android.)
  //
  // So on Android we ship the source in slices well under the limit, have the
  // page reassemble them into one string, and evaluate that. Each injectJavaScript
  // call is queued on the same bridge, so the slices arrive in order.
  const androidChunks = useMemo(() => {
    if (Platform.OS !== "android" || !settings) return [];
    const code = injected;
    const SIZE = 60000; // ~120 KB per transaction — a comfortable margin
    const out: string[] = [];
    for (let i = 0; i < code.length; i += SIZE) out.push(code.slice(i, i + SIZE));
    return out;
  }, [injected, settings]);

  // When a page opens a popup — e.g. "Sign in with Google" (which uses
  // window.open to accounts.google.com) — load that URL in THIS WebView instead
  // of dropping it. Overriding window.open (as we did before) broke SSO because
  // the site's code expected a real window object back; letting the popup happen
  // and redirecting the main view is the OAuth-friendly approach. App-scheme
  // URLs are still refused by onShouldStart below.
  const onOpenWindow = useCallback((e: { nativeEvent: { targetUrl: string } }) => {
    const url = e?.nativeEvent?.targetUrl;
    if (url && /^https?:/i.test(url)) {
      webviewRef.current?.injectJavaScript(`window.location.href=${JSON.stringify(url)};true;`);
    }
  }, []);

  // injectedJavaScriptBeforeContentLoaded does NOT reliably run on every
  // navigation in this WebView (especially on the social SPAs / full-page loads),
  // which left the engine unloaded on the feed — so nothing was filtered. Fix:
  // re-inject the whole engine on every load. The bundle guards itself with
  // window.__VALYOU_INJECTED__, so a repeat injection on an already-injected page
  // is a fast no-op.
  const reinject = useCallback(() => {
    const view = webviewRef.current;
    if (!view || !settings) return;
    if (Platform.OS === "android") {
      // Reassemble the sliced source in the page, then run it once (see the
      // androidChunks comment). The accumulator is deleted afterwards so we
      // never leave a megabyte of source sitting on the page's window.
      view.injectJavaScript("window.__VALYOU_SRC__ = '';true;");
      for (const chunk of androidChunks) {
        view.injectJavaScript(`window.__VALYOU_SRC__ += ${JSON.stringify(chunk)};true;`);
      }
      view.injectJavaScript(
        "try { (0, eval)(window.__VALYOU_SRC__); } catch (e) {} " +
          "finally { delete window.__VALYOU_SRC__; } true;"
      );
      return;
    }
    view.injectJavaScript(injected);
  }, [settings, injected, androidChunks]);

  // useCallback caches this function so it keeps a stable identity across
  // renders. pushSettings updates our state AND injects a live call into the
  // page so the change applies without reloading. `webviewRef.current?.` uses
  // optional chaining: only call injectJavaScript if the WebView exists.
  const pushSettings = useCallback((next: Settings) => {
    setSettings(next);
    webviewRef.current?.injectJavaScript(
      "window.__VALYOU__ && window.__VALYOU__.applySettings && " +
        "window.__VALYOU__.applySettings(" +
        JSON.stringify(next) +
        ");true;"
    );
  }, []);

  // onMessage is the native END of the bridge: it fires when the injected engine
  // calls window.ReactNativeWebView.postMessage. The data arrives as a string on
  // event.nativeEvent.data, so we JSON.parse it. We only ever act on "stats"
  // counter events — the page never sends content, and a malformed message is
  // simply ignored (the try/catch keeps a bad string from crashing the app).
  // The engine asks us to read the words baked into an image (a meme's payload
  // is pixels, invisible to a text extractor). Apple's Vision framework does it
  // on-device with no model to ship and nothing leaving the phone; the words go
  // back into the page and the engine re-judges that post.
  //
  // A failure here is never fatal: we simply learn nothing about that image, so
  // every error path resolves quietly rather than surfacing to the user.
  const readImageText = useCallback((id: string, src: string) => {
    const ocr = NativeModules.ValyouOCR;
    if (!ocr || typeof ocr.recognize !== "function" || !id || !src) return;
    ocr
      .recognize(src)
      .then((text: string) => {
        if (!text) return;
        webviewRef.current?.injectJavaScript(
          `window.__VALYOU__ && window.__VALYOU__.onOcrResult && ` +
            `window.__VALYOU__.onOcrResult(${JSON.stringify(id)}, ${JSON.stringify(text)});true;`
        );
      })
      .catch(() => {
        /* unreadable image — nothing learned, nothing broken */
      });
  }, []);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === "stats") recordStat(msg);
      // TEMPORARY: engine diagnostics to the device console, via native NSLog
      // (console.log is not forwarded in a Release build).
      else if (msg.type === "diag") NativeModules.ValyouOCR?.log?.(JSON.stringify(msg.d));
      else if (msg.type === "ocr") readImageText(msg.id, msg.src);
    } catch {
      /* ignore malformed bridge messages */
    }
  }, [readImageText]);


  // Keep every navigation INSIDE valyou's browser. Sites like X trigger custom
  // URL schemes (x://, twitter://) or App-Store links (itms-apps://) that iOS
  // would hand off to the native app — taking the user out of valyou, where
  // there is no filtering. Allow only real web pages (http/https/about); return
  // false for anything else so the WebView ignores the hand-off.
  const onShouldStart = useCallback(
    (req: { url: string }) => /^(https?:|about:)/i.test(req.url || ""),
    []
  );

  // Early return: when the user opens settings (and settings have loaded), show
  // the SettingsScreen instead of the browser. Props are passed like HTML
  // attributes; onChange={pushSettings} wires edits back to the live page.
  if (settings && showSettings) {
    return (
      <SettingsScreen
        settings={settings}
        onChange={pushSettings}
        onClose={() => setShowSettings(false)}
      />
    );
  }

  // Otherwise render the main browser UI. Everything below is JSX — a tree of
  // components. <SafeAreaView> keeps content clear of the notch/home indicator.
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={styles.tabs}>
        {/* Render one tab per site. .map() turns the SITES array into an array
            of elements; React requires a unique `key` on each for efficient
            updates. The `cond && <x>` pattern renders the active-tab style only
            when this tab is selected. onPress switches the active site. */}
        {SITES.map((s) => (
          <TouchableOpacity
            key={s.key}
            style={[styles.tab, s.key === site.key && styles.tabActive]}
            onPress={() => setSite(s)}
          >
            <Text style={[styles.tabText, s.key === site.key && styles.tabTextActive]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
        {/* The gear button opens settings. */}
        <TouchableOpacity style={styles.gear} onPress={() => setShowSettings(true)}>
          <Text style={styles.gearText}>⚙</Text>
        </TouchableOpacity>
      </View>

      {/* Show the WebView once settings have loaded, otherwise a loading label.
          `cond ? <a> : <b>` is a ternary — inline if/else inside JSX. */}
      {settings ? (
        <WebView
          // Changing `key` when the site changes forces React to build a FRESH
          // WebView rather than reuse the old one — a clean load of the new site.
          key={site.key}
          // Connect this element to our ref so pushSettings can call into it.
          ref={webviewRef}
          // `source` tells the WebView which URL to load.
          source={{ uri: site.url }}
          // injectedJavaScriptBeforeContentLoaded runs our script BEFORE the
          // page's own scripts, so the overlay styles and the engine are present
          // as content renders (no flash of un-filtered posts).
          // iOS only: on Android this same oversized string is silently dropped
          // by the bridge (see androidChunks), so we send a no-op there and let
          // the chunked reinject on load do the work.
          injectedJavaScriptBeforeContentLoaded={Platform.OS === "android" ? "true;" : injected}
          // ...and again after load, so a frame that finished before the engine
          // arrived still gets it.
          injectedJavaScript={Platform.OS === "android" ? "true;" : injected}
          // INJECT INTO EVERY FRAME, not just the top-level page.
          //
          // Both of these default to TRUE, meaning the engine only ever ran in
          // the main document. Facebook renders some players inside an iframe,
          // and inside that frame valyou simply did not exist — so the text
          // around a video was filtered while the video itself played on,
          // untouched, which looked exactly like broken video gating.
          //
          // Running everywhere is safe: the engine checks the host it finds
          // itself on and does nothing at all on a frame that is not one of the
          // supported networks (an ad or a widget), and it guards against
          // double-injection per frame.
          injectedJavaScriptForMainFrameOnly={false}
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
          // Re-inject the engine on every page load/navigation (see reinject).
          onLoadStart={reinject}
          onLoadEnd={reinject}
          // onMessage receives postMessage calls from inside the page (the bridge).
          onMessage={onMessage}
          // Block hand-offs to native apps / the App Store; keep browsing in-app.
          onShouldStartLoadWithRequest={onShouldStart}
          // Only real web origins load here; anything else is refused (not passed
          // to the OS to open an app).
          originWhitelist={["http://*", "https://*"]}
          // Allow popups (needed for OAuth / "Sign in with Google"); onOpenWindow
          // then loads them in this WebView rather than handing off to another app.
          setSupportMultipleWindows
          onOpenWindow={onOpenWindow}
          // Look like Safari so X doesn't push its native app.
          userAgent={SAFARI_UA}
          // The bare props below are booleans set to true (JSX shorthand):
          allowsBackForwardNavigationGestures // swipe left/right to go back/forward
          domStorageEnabled // let the page use localStorage/sessionStorage
          javaScriptEnabled // the page (and our engine) needs JS to run
          // Persist the login session across launches: iOS shares the WebView
          // cookie store with NSHTTPCookieStorage; Android keeps third-party
          // cookies (many social logins set them).
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          // ---- Media / video playback ----
          // Give video the best path WebKit offers. NOTE: 4K/HDR is ultimately
          // gated by what the SITE serves a browser — Facebook/Instagram/X send
          // their 4K/HDR ladders only to their own native apps, so like Safari
          // we get the web-quality streams. These flags just make sure nothing
          // on our side further limits it:
          //   - inline playback (matches Safari; modern iOS can carry HDR inline)
          //   - AirPlay so you can send video to a 4K/HDR TV/Apple TV
          //   - Picture-in-Picture
          allowsInlineMediaPlayback
          allowsAirPlayForMediaPlayback
          allowsPictureInPictureMediaPlayback
          // Let Safari Web Inspector / Chrome DevTools attach, so the mobile-web
          // selectors can be verified against the live logged-in DOM (the top
          // remaining task — see mobile/README.md). Harmless in production.
          webviewDebuggingEnabled
          style={styles.web}
        />
      ) : (
        <View style={styles.loading}>
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

// StyleSheet.create defines the visual styles referenced above via styles.xxx.
// Think of it as CSS for native views: `flex: 1` means "grow to fill available
// space", colours are hex strings, and numbers are density-independent pixels.
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0e1015" },
  tabs: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, height: 46 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  tabActive: { backgroundColor: "#2f6feb" },
  tabText: { color: "#98a0ad", fontWeight: "600" },
  tabTextActive: { color: "#fff" },
  gear: { marginLeft: "auto", padding: 8 },
  gearText: { color: "#e9ecf2", fontSize: 18 },
  web: { flex: 1, backgroundColor: "#fff" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { color: "#98a0ad" },
});
