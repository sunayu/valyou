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
 * A minimal DOM good enough to unit test extractors.js and apply.js.
 *
 * Pulling in jsdom would add a heavyweight dependency to a project that
 * otherwise has none, and would test far more surface than these two modules
 * touch. This stub implements exactly the API they use — element tree,
 * attributes, classList, event listeners, and a small CSS selector engine
 * covering tag / .class / [attr] / [attr="v"] / [attr*="v"], descendant
 * combinators, and comma groups.
 *
 * Anything the production code needs that is missing here fails loudly with a
 * TypeError rather than silently passing, which is the behaviour we want: a
 * missing stub method means the test is not actually exercising the code.
 */
"use strict";

/**
 * Parse one compound selector, e.g. `div[role="article"].foo`.
 *
 * @param {string} part Compound selector text.
 * @returns {{tag: string|null, classes: string[], attrs: Array<{name:string,op:string|null,value:string|null}>}}
 */
function parseCompound(part) {
  const compound = { tag: null, classes: [], attrs: [] };
  let rest = part;

  const tagMatch = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch) {
    compound.tag = tagMatch[0].toLowerCase();
    rest = rest.slice(tagMatch[0].length);
  }

  const token = /\.([\w-]+)|\[([\w-]+)(?:([*^$~|]?=)"([^"]*)")?\]/g;
  let match;
  while ((match = token.exec(rest)) !== null) {
    if (match[1]) {
      compound.classes.push(match[1]);
    } else {
      compound.attrs.push({
        name: match[2],
        op: match[3] || null,
        value: match[4] !== undefined ? match[4] : null,
      });
    }
  }
  return compound;
}

/**
 * Split a full selector into groups of compounds (outermost = comma groups,
 * inner array = descendant chain, left to right).
 *
 * @param {string} selector CSS selector.
 * @returns {Array<Array<object>>}
 */
function parseSelector(selector) {
  return String(selector)
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) => group.split(/\s+/).map(parseCompound));
}

/**
 * Does an element satisfy a single compound selector?
 *
 * @param {Element} element Candidate.
 * @param {object} compound Parsed compound.
 * @returns {boolean}
 */
function matchesCompound(element, compound) {
  if (compound.tag && element.tagName.toLowerCase() !== compound.tag) return false;

  for (const className of compound.classes) {
    if (!element.classList.contains(className)) return false;
  }

  for (const attribute of compound.attrs) {
    const actual = element.getAttribute(attribute.name);
    if (actual === null) return false;
    if (attribute.op === null) continue; // bare [attr] — presence is enough
    if (attribute.op === "=" && actual !== attribute.value) return false;
    if (attribute.op === "*=" && !actual.includes(attribute.value)) return false;
    if (attribute.op === "^=" && !actual.startsWith(attribute.value)) return false;
    if (attribute.op === "$=" && !actual.endsWith(attribute.value)) return false;
  }
  return true;
}

/**
 * Match an element against a full selector, honouring descendant combinators
 * by walking ancestors right to left.
 *
 * @param {Element} element Candidate.
 * @param {string} selector CSS selector.
 * @returns {boolean}
 */
function matchesSelector(element, selector) {
  for (const chain of parseSelector(selector)) {
    // The rightmost compound must match the element itself.
    if (!matchesCompound(element, chain[chain.length - 1])) continue;

    let index = chain.length - 2;
    let ancestor = element.parentElement;
    while (index >= 0 && ancestor) {
      if (matchesCompound(ancestor, chain[index])) index -= 1;
      ancestor = ancestor.parentElement;
    }
    if (index < 0) return true;
  }
  return false;
}

/** A DOM element. */
class Element {
  /**
   * @param {string} tagName Tag name.
   * @param {Document} ownerDocument Owning document.
   */
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this._attributes = new Map();
    this._text = "";
    this._listeners = new Map();
    this.style = {};

    const self = this;
    this.classList = {
      /** @param {...string} names */
      add(...names) {
        const set = self._classSet();
        names.forEach((n) => set.add(n));
        self._writeClasses(set);
      },
      /** @param {...string} names */
      remove(...names) {
        const set = self._classSet();
        names.forEach((n) => set.delete(n));
        self._writeClasses(set);
      },
      /** @param {string} name @returns {boolean} */
      contains(name) {
        return self._classSet().has(name);
      },
      /** @param {string} name @param {boolean} [force] */
      toggle(name, force) {
        const set = self._classSet();
        const want = force === undefined ? !set.has(name) : force;
        if (want) set.add(name);
        else set.delete(name);
        self._writeClasses(set);
      },
    };
  }

  /** @returns {Set<string>} Current class names. */
  _classSet() {
    return new Set(String(this._attributes.get("class") || "").split(/\s+/).filter(Boolean));
  }

  /** @param {Set<string>} set Class names to write back. */
  _writeClasses(set) {
    this._attributes.set("class", Array.from(set).join(" "));
  }

  /** @returns {string} The class attribute, mirroring the real DOM property. */
  get className() {
    return this._attributes.get("class") || "";
  }

  /** @param {string} value Whitespace-separated class names. */
  set className(value) {
    this._attributes.set("class", String(value));
  }

  /** @returns {Element|null} */
  get firstChild() {
    return this.children[0] || null;
  }

  /**
   * Concatenated text of this element and its descendants. Leaf elements
   * carry their own `_text`; branches derive it from children, matching how
   * the real DOM behaves for the purposes of extractors.readText.
   *
   * @returns {string}
   */
  get textContent() {
    if (this.children.length === 0) return this._text;
    // Mixed content: own text (if any) followed by the children's text.
    const own = this._text ? [this._text] : [];
    return own.concat(this.children.map((c) => c.textContent)).join(" ");
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }

  /**
   * Like the real DOM's childNodes: DIRECT text nodes (nodeType 3) plus the
   * element children, in order. Our stub keeps at most one own-text chunk
   * (`_text`), which it exposes as a single leading text node — enough to
   * model the MIXED-CONTENT shape (caption text node beside emoji <span>s)
   * that extractors.readText must handle.
   */
  get childNodes() {
    const nodes = [];
    if (this._text) nodes.push({ nodeType: 3, textContent: this._text });
    return nodes.concat(this.children);
  }

  /** @param {string} name @returns {string|null} */
  getAttribute(name) {
    return this._attributes.has(name) ? String(this._attributes.get(name)) : null;
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this._attributes.set(name, String(value));
  }

  /** @param {string} name */
  removeAttribute(name) {
    this._attributes.delete(name);
  }

  /** @param {string} name @returns {boolean} */
  hasAttribute(name) {
    return this._attributes.has(name);
  }

  /** @param {Element} child @returns {Element} */
  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  /**
   * @param {Element} child Node to insert.
   * @param {Element|null} reference Insert before this node; null appends.
   * @returns {Element}
   */
  insertBefore(child, reference) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  /** @param {Element} child @returns {Element} */
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }

  /** @param {string} selector @returns {boolean} */
  matches(selector) {
    return matchesSelector(this, selector);
  }

  /** @param {string} selector @returns {Element|null} Self-or-ancestor match. */
  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  /** @param {string} selector @returns {Element[]} Descendants in document order. */
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  /** @param {string} selector @returns {Element|null} */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  /** @param {string} type @param {function} handler */
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  /**
   * Fire an event with the minimum surface the production handlers use.
   *
   * @param {string} type Event type.
   * @returns {{defaultPrevented: boolean, propagationStopped: boolean}}
   */
  dispatch(type, props) {
    const event = {
      type,
      defaultPrevented: false,
      propagationStopped: false,
      // Gesture handlers read clientX/clientY; tests pass them through `props`
      // to simulate a swipe. Defaults keep every existing caller working.
      clientX: 0,
      clientY: 0,
      ...(props || {}),
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
    };
    for (const handler of this._listeners.get(type) || []) handler(event);
    return event;
  }

  /** Convenience alias used by tests. */
  click() {
    return this.dispatch("click");
  }
}

/** A DOM document. */
class Document {
  constructor() {
    this.body = new Element("body", this);
  }

  /** @param {string} tagName @returns {Element} */
  createElement(tagName) {
    return new Element(tagName, this);
  }

  /** @param {string} selector @returns {Element[]} */
  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }
}

/**
 * Build an element tree from a compact literal, so tests read as structure
 * rather than as a wall of imperative construction.
 *
 * @param {Document} doc Owning document.
 * @param {{tag?: string, attrs?: object, text?: string, children?: Array}} spec
 * @returns {Element}
 */
function build(doc, spec) {
  const element = doc.createElement(spec.tag || "div");
  for (const [name, value] of Object.entries(spec.attrs || {})) {
    element.setAttribute(name, value);
  }
  if (spec.text !== undefined) element.textContent = spec.text;
  for (const child of spec.children || []) element.appendChild(build(doc, child));
  return element;
}

module.exports = { Element, Document, build, matchesSelector, parseSelector };
