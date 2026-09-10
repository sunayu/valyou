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

#import "ValyouOCR.h"
#import <Vision/Vision.h>
#import <UIKit/UIKit.h>

@implementation ValyouOCR {
  /** Cache of already-read images, keyed by URL: feeds re-render constantly and
   *  the same meme scrolls past many times. Bounded so a long session cannot
   *  grow it without limit. */
  NSMutableDictionary<NSString *, NSString *> *_cache;
  NSMutableArray<NSString *> *_cacheOrder;
}

RCT_EXPORT_MODULE(ValyouOCR);

/** Ceiling on cached results (roughly a few hundred KB of text). */
static const NSUInteger kMaxCacheEntries = 300;

/** Refuse absurd downloads: a feed image is tens to hundreds of KB. */
static const NSUInteger kMaxImageBytes = 8 * 1024 * 1024;

- (instancetype)init {
  if ((self = [super init])) {
    _cache = [NSMutableDictionary new];
    _cacheOrder = [NSMutableArray new];
  }
  return self;
}

/** Vision work is not main-thread work; keep the UI free. */
- (dispatch_queue_t)methodQueue {
  return dispatch_queue_create("cx.valyou.ocr", DISPATCH_QUEUE_SERIAL);
}

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (void)cacheText:(NSString *)text forKey:(NSString *)key {
  @synchronized(self) {
    if (_cache[key] == nil) {
      [_cacheOrder addObject:key];
      // Evict oldest-first once the cap is reached.
      while (_cacheOrder.count > kMaxCacheEntries) {
        NSString *oldest = _cacheOrder.firstObject;
        [_cacheOrder removeObjectAtIndex:0];
        [_cache removeObjectForKey:oldest];
      }
    }
    _cache[key] = text;
  }
}

/**
 * Recognize the text in one image.
 *
 * @param source Either an https URL, or a `data:image/...;base64,...` URI for
 *               an image the page has already decoded (canvas/blob).
 * Resolves with the recognized text (empty string when there is none) so the
 * caller can always treat the result as a string. Rejects only on programmer
 * error; anything environmental resolves empty, because a failed OCR must never
 * break filtering — it just means we learned nothing about that image.
 */
RCT_EXPORT_METHOD(recognize:(NSString *)source
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (source.length == 0) {
    resolve(@"");
    return;
  }

  @synchronized(self) {
    NSString *hit = _cache[source];
    if (hit != nil) {
      resolve(hit);
      return;
    }
  }

  NSData *data = nil;
  if ([source hasPrefix:@"data:"]) {
    NSRange comma = [source rangeOfString:@","];
    if (comma.location == NSNotFound) {
      resolve(@"");
      return;
    }
    NSString *b64 = [source substringFromIndex:comma.location + 1];
    data = [[NSData alloc] initWithBase64EncodedString:b64
                                               options:NSDataBase64DecodingIgnoreUnknownCharacters];
  } else {
    NSURL *url = [NSURL URLWithString:source];
    // Only ever fetch over https, and only an image we are about to read
    // locally. Nothing about the request tells anyone what the user is
    // reading — it is the same CDN image the page just displayed.
    if (url == nil || ![url.scheme isEqualToString:@"https"]) {
      resolve(@"");
      return;
    }
    NSURLRequest *request =
        [NSURLRequest requestWithURL:url
                         cachePolicy:NSURLRequestReturnCacheDataElseLoad
                     timeoutInterval:10];
    // Block this private serial queue until the image arrives. Serialising
    // here is deliberate: it means a fast scroll cannot kick off dozens of
    // concurrent downloads and Vision requests. (NSURLConnection's synchronous
    // API is deprecated, so drive NSURLSession and wait on a semaphore.)
    __block NSData *fetched = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    NSURLSessionDataTask *task = [[NSURLSession sharedSession]
        dataTaskWithRequest:request
          completionHandler:^(NSData *body, NSURLResponse *response, NSError *error) {
            NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]]
                                   ? [(NSHTTPURLResponse *)response statusCode]
                                   : 200;
            if (error == nil && status >= 200 && status < 300) fetched = body;
            dispatch_semaphore_signal(done);
          }];
    [task resume];
    // Never wait forever: a hung CDN must not stall the OCR queue.
    if (dispatch_semaphore_wait(done,
                                dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC)) != 0) {
      [task cancel];
      resolve(@"");
      return;
    }
    data = fetched;
  }

  if (data == nil || data.length == 0 || data.length > kMaxImageBytes) {
    resolve(@"");
    return;
  }

  UIImage *image = [UIImage imageWithData:data];
  if (image == nil || image.CGImage == NULL) {
    resolve(@"");
    return;
  }

  VNImageRequestHandler *handler =
      [[VNImageRequestHandler alloc] initWithCGImage:image.CGImage options:@{}];
  VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
  // "Accurate" costs more time but meme typography (heavy fonts, outlines,
  // overlays) defeats the fast path often enough to matter.
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  // Language correction fixes the common OCR confusions (rn/m, 0/O) that would
  // otherwise let an obfuscated slur slip past the lexicon.
  request.usesLanguageCorrection = YES;

  NSError *visionError = nil;
  [handler performRequests:@[ request ] error:&visionError];
  if (visionError != nil) {
    resolve(@"");
    return;
  }

  NSMutableArray<NSString *> *lines = [NSMutableArray new];
  for (VNRecognizedTextObservation *observation in request.results) {
    VNRecognizedText *best = [[observation topCandidates:1] firstObject];
    // Drop low-confidence reads: a wrong word is worse than no word, because it
    // could either invent a slur or mask one.
    if (best != nil && best.confidence >= 0.4f && best.string.length > 0) {
      [lines addObject:best.string];
    }
  }

  NSString *text = [lines componentsJoinedByString:@" "];
  [self cacheText:text forKey:source];
  resolve(text);
}

/**
 * Write a line to the device console.
 *
 * React Native does not forward console.log to stdout in a Release build, so
 * JavaScript has no way to report from a real device. NSLog does reach it, and
 * `xcrun devicectl device process launch --console` streams it — which is the
 * only remote diagnostic channel that works on a modern iPhone.
 */
RCT_EXPORT_METHOD(log:(NSString *)line) {
  NSLog(@"[valyou] %@", line);
}

@end
