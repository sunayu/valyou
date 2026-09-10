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
 * Metro bundler configuration.
 *
 * We ship the filtering engine as a single pre-built string module
 * (mobile/dist/valyou-inject.bundle.js, which does `module.exports = "<bundle>"`)
 * and inject it into the WebView. That is an ordinary CommonJS module, so it
 * needs no custom transformer — a plain `require` returns the string.
 *
 * The only non-default here is the watchFolder: the bundle lives outside the
 * app directory (in mobile/dist, shared with the Node test suite), so Metro has
 * to be told to watch one level up.
 */
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const path = require("path");

const defaultConfig = getDefaultConfig(__dirname);

/** @type {import('metro-config').MetroConfig} */
const config = {
  // Let Metro see mobile/dist (one level up from the app dir).
  watchFolders: [path.resolve(__dirname, "..")],
};

module.exports = mergeConfig(defaultConfig, config);
