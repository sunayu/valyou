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

#import <React/RCTBridgeModule.h>

/**
 * Reads the words baked into an image, entirely on the device.
 *
 * WHY THIS EXISTS
 * A large share of hateful content on Facebook and Instagram is a MEME: the
 * payload is text rendered into pixels, invisible to a DOM text extractor.
 * valyou already reads image `alt` text where a platform provides it, but that
 * describes the picture ("May be an image of two people"), not the words on it.
 *
 * WHY NATIVE, AND WHY THIS IS STILL PRIVATE
 * Apple's Vision framework ships with iOS and recognizes text fully offline —
 * no model download, no server, nothing leaves the phone. That keeps valyou's
 * central promise intact ("nothing you browse ever leaves your device") while
 * costing zero app-bundle size, unlike a WASM OCR engine.
 */
@interface ValyouOCR : NSObject <RCTBridgeModule>
@end
