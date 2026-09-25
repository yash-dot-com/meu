//#region dom/locatorScripts/xpathParser.ts
/**
* Parse an XPath expression into a list of traversal steps.
*
* This is a subset parser designed for composed DOM traversal (including
* shadow roots). It intentionally does not implement the full XPath spec.
*
* Supported:
*  - Child (`/`) and descendant (`//`) axes
*  - Tag names and wildcard (`*`)
*  - Positional indices (`[n]`)
*  - Attribute equality predicates (`[@attr='value']`, `[@attr="value"]`)
*  - Attribute existence (`[@attr]`)
*  - Attribute contains/starts-with (`contains(@attr,'v')`, `starts-with(@attr,'v')`)
*  - Text equality/contains (`[text()='v']`, `[contains(text(),'v')]`, `[.='v']`)
*  - normalize-space on text/attributes (`[normalize-space(text())='v']`)
*  - Basic boolean predicates (`and`, `or`, `not(...)`)
*  - Multiple predicates per step (`[@class='foo'][2]`)
*  - Optional `xpath=` prefix
*
* Not supported:
*  - Position functions (`[position() > n]`, `[last()]`)
*  - Axes beyond child/descendant (`ancestor::`, `parent::`, `self::`,
*    `preceding-sibling::`, `following-sibling::`)
*  - Union operator (`|`)
*  - Grouped expressions (`(//div)[n]`)
*
* Unsupported predicates are silently ignored — the step still matches
* by tag name, but the unrecognized predicate has no filtering effect.
*/
function parseXPathSteps(input) {
	const path = String(input || "").trim().replace(/^xpath=/i, "");
	if (!path) return [];
	const steps = [];
	let i = 0;
	while (i < path.length) {
		let axis = "child";
		if (path.startsWith("//", i)) {
			axis = "desc";
			i += 2;
		} else if (path[i] === "/") {
			axis = "child";
			i += 1;
		}
		const start = i;
		let bracketDepth = 0;
		let quote = null;
		while (i < path.length) {
			const ch = path[i];
			if (quote) {
				if (ch === quote) quote = null;
			} else if (ch === "'" || ch === "\"") quote = ch;
			else if (ch === "[") bracketDepth++;
			else if (ch === "]") bracketDepth--;
			else if (ch === "/" && bracketDepth === 0) break;
			i += 1;
		}
		const rawStep = path.slice(start, i).trim();
		if (!rawStep) continue;
		const { tag, predicates } = parseStep(rawStep);
		steps.push({
			axis,
			tag,
			predicates
		});
	}
	return steps;
}
/**
* Extract predicate contents from a string like `[@attr='val'][2]`.
* Handles `]` inside quoted attribute values (e.g. `[@title='a[0]']`).
*/
function extractPredicates(str) {
	const results = [];
	let i = 0;
	while (i < str.length) {
		if (str[i] !== "[") {
			i++;
			continue;
		}
		i++;
		const start = i;
		let quote = null;
		while (i < str.length) {
			const ch = str[i];
			if (quote) {
				if (ch === quote) quote = null;
			} else if (ch === "'" || ch === "\"") quote = ch;
			else if (ch === "]") break;
			i++;
		}
		results.push(str.slice(start, i).trim());
		i++;
	}
	return results;
}
function parseStep(raw) {
	const bracketPos = raw.indexOf("[");
	if (bracketPos === -1) return {
		tag: raw === "" ? "*" : raw.toLowerCase(),
		predicates: []
	};
	const tagPart = raw.slice(0, bracketPos).trim();
	const tag = tagPart === "" ? "*" : tagPart.toLowerCase();
	const predicateStr = raw.slice(bracketPos);
	const predicates = [];
	for (const inner of extractPredicates(predicateStr)) {
		const parsed = parsePredicateExpression(inner);
		if (parsed) predicates.push(parsed);
	}
	return {
		tag,
		predicates
	};
}
function parsePredicateExpression(input) {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const orParts = splitTopLevel(trimmed, "or");
	if (orParts.length > 1) {
		const preds = orParts.map((part) => parsePredicateExpression(part)).filter(Boolean);
		if (preds.length !== orParts.length) return null;
		return {
			type: "or",
			predicates: preds
		};
	}
	const andParts = splitTopLevel(trimmed, "and");
	if (andParts.length > 1) {
		const preds = andParts.map((part) => parsePredicateExpression(part)).filter(Boolean);
		if (preds.length !== andParts.length) return null;
		return {
			type: "and",
			predicates: preds
		};
	}
	const notInner = unwrapFunctionCall(trimmed, "not");
	if (notInner != null) {
		const predicate = parsePredicateExpression(notInner);
		return predicate ? {
			type: "not",
			predicate
		} : null;
	}
	return parseAtomicPredicate(trimmed);
}
function parseAtomicPredicate(input) {
	const valueMatch = /^(?:'([^']*)'|"([^"]*)")$/;
	const attrName = "[a-zA-Z_][\\w.-]*";
	const quoted = "(?:'([^']*)'|\"([^\"]*)\")";
	if (/^\d+$/.test(input)) return {
		type: "index",
		index: Math.max(1, Number(input))
	};
	const normalizeAttrMatch = input.match(new RegExp(`^normalize-space\\(\\s*@(${attrName})\\s*\\)\\s*=\\s*${quoted}$`));
	if (normalizeAttrMatch) return {
		type: "attrEquals",
		name: normalizeAttrMatch[1],
		value: normalizeAttrMatch[2] ?? normalizeAttrMatch[3] ?? "",
		normalize: true
	};
	const normalizeTextMatch = input.match(new RegExp(`^normalize-space\\(\\s*(?:text\\(\\)|\\.)\\s*\\)\\s*=\\s*${quoted}$`));
	if (normalizeTextMatch) return {
		type: "textEquals",
		value: normalizeTextMatch[1] ?? normalizeTextMatch[2] ?? "",
		normalize: true
	};
	const attrEqualsMatch = input.match(new RegExp(`^@(${attrName})\\s*=\\s*${quoted}$`));
	if (attrEqualsMatch) return {
		type: "attrEquals",
		name: attrEqualsMatch[1],
		value: attrEqualsMatch[2] ?? attrEqualsMatch[3] ?? ""
	};
	const attrExistsMatch = input.match(new RegExp(`^@(${attrName})$`));
	if (attrExistsMatch) return {
		type: "attrExists",
		name: attrExistsMatch[1]
	};
	const attrContainsMatch = input.match(new RegExp(`^contains\\(\\s*@(${attrName})\\s*,\\s*${quoted}\\s*\\)$`));
	if (attrContainsMatch) return {
		type: "attrContains",
		name: attrContainsMatch[1],
		value: attrContainsMatch[2] ?? attrContainsMatch[3] ?? ""
	};
	const attrStartsMatch = input.match(new RegExp(`^starts-with\\(\\s*@(${attrName})\\s*,\\s*${quoted}\\s*\\)$`));
	if (attrStartsMatch) return {
		type: "attrStartsWith",
		name: attrStartsMatch[1],
		value: attrStartsMatch[2] ?? attrStartsMatch[3] ?? ""
	};
	const textEqualsMatch = input.match(new RegExp(`^(?:text\\(\\)|\\.)\\s*=\\s*${quoted}$`));
	if (textEqualsMatch) return {
		type: "textEquals",
		value: textEqualsMatch[1] ?? textEqualsMatch[2] ?? ""
	};
	const textContainsMatch = input.match(new RegExp(`^contains\\(\\s*(?:text\\(\\)|\\.)\\s*,\\s*${quoted}\\s*\\)$`));
	if (textContainsMatch) return {
		type: "textContains",
		value: textContainsMatch[1] ?? textContainsMatch[2] ?? ""
	};
	if (valueMatch.test(input)) return null;
	return null;
}
function splitTopLevel(input, keyword) {
	const parts = [];
	let start = 0;
	let depth = 0;
	let quote = null;
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) quote = null;
			i += 1;
			continue;
		}
		if (ch === "'" || ch === "\"") {
			quote = ch;
			i += 1;
			continue;
		}
		if (ch === "(") {
			depth += 1;
			i += 1;
			continue;
		}
		if (ch === ")") {
			depth = Math.max(0, depth - 1);
			i += 1;
			continue;
		}
		if (depth === 0 && isKeywordAt(input, i, keyword)) {
			parts.push(input.slice(start, i).trim());
			i += keyword.length;
			start = i;
			continue;
		}
		i += 1;
	}
	parts.push(input.slice(start).trim());
	return parts.filter((part) => part.length > 0);
}
function isKeywordAt(input, index, keyword) {
	if (!input.startsWith(keyword, index)) return false;
	const before = index > 0 ? input[index - 1] : " ";
	if (before === "@") return false;
	const after = index + keyword.length < input.length ? input[index + keyword.length] : " ";
	return isBoundary(before) && isBoundary(after);
}
function isBoundary(ch) {
	return !/[a-zA-Z0-9_.-]/.test(ch);
}
function unwrapFunctionCall(input, name) {
	const prefix = `${name}(`;
	if (!input.startsWith(prefix) || !input.endsWith(")")) return null;
	const inner = input.slice(prefix.length, -1);
	return hasBalancedParens(inner) ? inner : null;
}
function hasBalancedParens(input) {
	let depth = 0;
	let quote = null;
	for (let i = 0; i < input.length; i += 1) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === "\"") {
			quote = ch;
			continue;
		}
		if (ch === "(") depth += 1;
		else if (ch === ")") depth -= 1;
		if (depth < 0) return false;
	}
	return depth === 0;
}
var normalizeSpace = (value) => value.replace(/\s+/g, " ").trim();
function textValue(element) {
	return String(element.textContent ?? "");
}
function normalizeMaybe(value, normalize) {
	return normalize ? normalizeSpace(value) : value;
}
function evaluatePredicate(element, predicate) {
	switch (predicate.type) {
		case "and": return predicate.predicates.every((p) => evaluatePredicate(element, p));
		case "or": return predicate.predicates.some((p) => evaluatePredicate(element, p));
		case "not": return !evaluatePredicate(element, predicate.predicate);
		case "attrExists": return element.getAttribute(predicate.name) !== null;
		case "attrEquals": {
			const attr = element.getAttribute(predicate.name);
			if (attr === null) return false;
			return normalizeMaybe(attr, predicate.normalize) === normalizeMaybe(predicate.value, predicate.normalize);
		}
		case "attrContains": {
			const attr = element.getAttribute(predicate.name);
			if (attr === null) return false;
			return normalizeMaybe(attr, predicate.normalize).includes(normalizeMaybe(predicate.value, predicate.normalize));
		}
		case "attrStartsWith": {
			const attr = element.getAttribute(predicate.name);
			if (attr === null) return false;
			return normalizeMaybe(attr, predicate.normalize).startsWith(normalizeMaybe(predicate.value, predicate.normalize));
		}
		case "textEquals": return normalizeMaybe(textValue(element), predicate.normalize) === normalizeMaybe(predicate.value, predicate.normalize);
		case "textContains": return normalizeMaybe(textValue(element), predicate.normalize).includes(normalizeMaybe(predicate.value, predicate.normalize));
		case "index": return true;
		default: return true;
	}
}
function applyPredicates(elements, predicates) {
	let current = elements;
	for (const predicate of predicates) {
		if (!current.length) return [];
		if (predicate.type === "index") {
			const idx = predicate.index - 1;
			current = idx >= 0 && idx < current.length ? [current[idx]] : [];
			continue;
		}
		current = current.filter((el) => evaluatePredicate(el, predicate));
	}
	return current;
}
//#endregion
//#region dom/locatorScripts/shadowRoots.ts
function getOpenOrClosedShadowRoot(element) {
	try {
		if (element instanceof HTMLElement) {
			const root = globalThis.chrome?.dom?.openOrClosedShadowRoot(element);
			if (root) return root;
		}
	} catch {}
	try {
		return element.shadowRoot ?? null;
	} catch {
		return null;
	}
}
function documentHasShadowRoot() {
	try {
		const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
		while (walker.nextNode()) if (getOpenOrClosedShadowRoot(walker.currentNode)) return true;
	} catch {}
	return false;
}
//#endregion
//#region dom/locatorScripts/xpathResolver.ts
var normalizeXPath = (selector) => {
	const raw = String(selector ?? "").trim();
	if (!raw) return "";
	return raw.replace(/^xpath=/i, "").trim();
};
function resolveXPathFirst(rawXp, options) {
	return resolveXPathAtIndex(rawXp, 0, options);
}
function resolveXPathAtIndex(rawXp, index, options) {
	if (!Number.isFinite(index) || index < 0) return null;
	const xp = normalizeXPath(rawXp);
	if (!xp) return null;
	const targetIndex = Math.floor(index);
	const pierceShadow = options?.pierceShadow !== false;
	const shadowCtx = pierceShadow ? getShadowContext() : null;
	if (!pierceShadow) return resolveNativeAtIndexWithError(xp, targetIndex).value;
	if (!shadowCtx?.hasShadow) {
		const native = resolveNativeAtIndexWithError(xp, targetIndex);
		if (!native.error) return native.value;
		return resolveXPathComposedMatches(xp, shadowCtx?.getShadowRoot)[targetIndex] ?? null;
	}
	const shadowHopMatches = resolveStagehandShadowHopMatches(xp, shadowCtx.getShadowRoot);
	if (shadowHopMatches.length > 0) return shadowHopMatches[targetIndex] ?? null;
	return resolveXPathComposedMatches(xp, shadowCtx.getShadowRoot)[targetIndex] ?? null;
}
function countXPathMatches(rawXp, options) {
	const xp = normalizeXPath(rawXp);
	if (!xp) return 0;
	const pierceShadow = options?.pierceShadow !== false;
	const shadowCtx = pierceShadow ? getShadowContext() : null;
	if (!pierceShadow) return resolveNativeCountWithError(xp).count;
	if (!shadowCtx?.hasShadow) {
		const count = resolveNativeCountWithError(xp);
		if (!count.error) return count.count;
		return resolveXPathComposedMatches(xp, shadowCtx?.getShadowRoot).length;
	}
	const shadowHopCount = resolveStagehandShadowHopMatches(xp, shadowCtx.getShadowRoot).length;
	if (shadowHopCount > 0) return shadowHopCount;
	return resolveXPathComposedMatches(xp, shadowCtx.getShadowRoot).length;
}
function resolveXPathComposedMatches(rawXp, getShadowRoot) {
	const xp = normalizeXPath(rawXp);
	if (!xp) return [];
	const steps = parseXPathSteps(xp);
	if (!steps.length) return [];
	const shadowRootGetter = getShadowRoot ?? null;
	let current = [document];
	for (const step of steps) {
		const next = [];
		const seen = /* @__PURE__ */ new Set();
		for (const root of current) {
			const pool = step.axis === "child" ? composedChildren(root, shadowRootGetter) : composedDescendants(root, shadowRootGetter);
			if (!pool.length) continue;
			const matches = applyPredicates(pool.filter((candidate) => matchesTag(candidate, step)), step.predicates);
			for (const candidate of matches) if (!seen.has(candidate)) {
				seen.add(candidate);
				next.push(candidate);
			}
		}
		if (!next.length) return [];
		current = next;
	}
	return current;
}
function resolveStagehandShadowHopMatches(rawXp, getShadowRoot) {
	const xp = normalizeXPath(rawXp);
	if (!xp) return [];
	const steps = parseXPathSteps(xp);
	if (!steps.some((step, index) => step.axis === "desc" && index > 0)) return [];
	const shadowRootGetter = getShadowRoot ?? null;
	let current = [document];
	for (let i = 0; i < steps.length; i += 1) {
		const step = steps[i];
		const next = [];
		const seen = /* @__PURE__ */ new Set();
		for (const root of current) {
			const pool = step.axis === "child" ? domChildren(root) : i === 0 ? composedDescendants(root, shadowRootGetter) : shadowRootChildren(root, shadowRootGetter);
			if (!pool.length) continue;
			const matches = applyPredicates(pool.filter((candidate) => matchesTag(candidate, step)), step.predicates);
			for (const candidate of matches) if (!seen.has(candidate)) {
				seen.add(candidate);
				next.push(candidate);
			}
		}
		if (!next.length) return [];
		current = next;
	}
	return current;
}
function matchesTag(element, step) {
	if (step.tag === "*") return true;
	return element.localName === step.tag;
}
function getShadowContext() {
	return {
		getShadowRoot: getOpenOrClosedShadowRoot,
		hasShadow: documentHasShadowRoot()
	};
}
function composedChildren(node, getShadowRoot) {
	const out = [];
	if (node instanceof Document) {
		if (node.documentElement) out.push(node.documentElement);
		return out;
	}
	if (node instanceof ShadowRoot || node instanceof DocumentFragment) {
		out.push(...Array.from(node.children ?? []));
		return out;
	}
	if (node instanceof Element) {
		out.push(...Array.from(node.children ?? []));
		const shadowRoot = getShadowRoot?.(node) ?? getOpenOrClosedShadowRoot(node);
		if (shadowRoot) out.push(...Array.from(shadowRoot.children ?? []));
		return out;
	}
	return out;
}
function domChildren(node) {
	const out = [];
	if (node instanceof Document) {
		if (node.documentElement) out.push(node.documentElement);
		return out;
	}
	if (node instanceof ShadowRoot || node instanceof DocumentFragment) {
		out.push(...Array.from(node.children ?? []));
		return out;
	}
	if (node instanceof Element) {
		out.push(...Array.from(node.children ?? []));
		return out;
	}
	return out;
}
function shadowRootChildren(node, getShadowRoot) {
	const out = [];
	if (!(node instanceof Element)) return out;
	const shadowRoot = getShadowRoot?.(node) ?? getOpenOrClosedShadowRoot(node);
	if (shadowRoot) out.push(...Array.from(shadowRoot.children ?? []));
	return out;
}
function composedDescendants(node, getShadowRoot) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const stack = [...composedChildren(node, getShadowRoot)].reverse();
	while (stack.length) {
		const next = stack.pop();
		if (seen.has(next)) continue;
		seen.add(next);
		out.push(next);
		const children = composedChildren(next, getShadowRoot);
		for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
	}
	return out;
}
function resolveNativeAtIndexWithError(xp, index) {
	try {
		return {
			value: document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotItem(index),
			error: false
		};
	} catch {
		return {
			value: null,
			error: true
		};
	}
}
function resolveNativeCountWithError(xp) {
	try {
		return {
			count: document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength,
			error: false
		};
	} catch {
		return {
			count: 0,
			error: true
		};
	}
}
//#endregion
//#region dom/locatorScripts/counts.ts
function countCssMatchesPrimary(selectorRaw) {
	const selector = String(selectorRaw ?? "").trim();
	if (!selector) return 0;
	const seen = /* @__PURE__ */ new WeakSet();
	const visit = (root) => {
		if (!root || seen.has(root)) return 0;
		seen.add(root);
		let total = 0;
		try {
			const queryable = root;
			if (typeof queryable.querySelectorAll === "function") total += queryable.querySelectorAll(selector).length;
		} catch {}
		try {
			const walker = (root instanceof Document ? root : root?.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
			let node;
			while (node = walker.nextNode()) if (node instanceof Element) {
				const shadowRoot = getOpenOrClosedShadowRoot(node);
				if (shadowRoot) total += visit(shadowRoot);
			}
		} catch {}
		return total;
	};
	try {
		return visit(document);
	} catch {
		try {
			return document.querySelectorAll(selector).length;
		} catch {
			return 0;
		}
	}
}
function countTextMatches(rawNeedle) {
	const needle = String(rawNeedle ?? "");
	if (!needle) return {
		count: 0,
		sample: [],
		error: null
	};
	const needleLc = needle.toLowerCase();
	const skipTags = /* @__PURE__ */ new Set([
		"SCRIPT",
		"STYLE",
		"TEMPLATE",
		"NOSCRIPT",
		"HEAD",
		"TITLE",
		"LINK",
		"META",
		"HTML",
		"BODY"
	]);
	const shouldSkip = (node) => {
		if (!node) return false;
		const tag = node.tagName?.toUpperCase() ?? "";
		return skipTags.has(tag);
	};
	const extractText = (element) => {
		try {
			if (shouldSkip(element)) return "";
			const inner = element.innerText;
			if (typeof inner === "string" && inner.trim()) return inner.trim();
		} catch {}
		try {
			const text = element.textContent;
			if (typeof text === "string") return text.trim();
		} catch {}
		return "";
	};
	const matches = (element) => {
		const text = extractText(element);
		return !!text && text.toLowerCase().includes(needleLc);
	};
	const seen = /* @__PURE__ */ new WeakSet();
	const queue = [];
	const enqueue = (node) => {
		if (!node || seen.has(node)) return;
		seen.add(node);
		queue.push(node);
	};
	const walkerFor = (root) => {
		try {
			return (root instanceof Document ? root : root?.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
		} catch {
			return null;
		}
	};
	const matchesList = [];
	enqueue(document);
	while (queue.length) {
		const root = queue.shift();
		if (!root) continue;
		if (root instanceof Element && matches(root)) matchesList.push({
			element: root,
			tag: root.tagName ?? "",
			id: root.id ?? "",
			className: root.className ?? "",
			text: extractText(root)
		});
		const walker = walkerFor(root);
		if (!walker) continue;
		let node;
		while (node = walker.nextNode()) {
			if (!(node instanceof Element)) continue;
			if (matches(node)) matchesList.push({
				element: node,
				tag: node.tagName ?? "",
				id: node.id ?? "",
				className: node.className ?? "",
				text: extractText(node)
			});
			const shadowRoot = getOpenOrClosedShadowRoot(node);
			if (shadowRoot) enqueue(shadowRoot);
		}
	}
	const innermost = [];
	for (const item of matchesList) {
		const el = item.element;
		let skip = false;
		for (const other of matchesList) {
			if (item === other) continue;
			try {
				if (el.contains(other.element)) {
					skip = true;
					break;
				}
			} catch {}
		}
		if (!skip) innermost.push(item);
	}
	return {
		count: innermost.length,
		sample: innermost.slice(0, 5).map((item) => ({
			tag: item.tag,
			id: item.id,
			class: item.className,
			text: item.text
		})),
		error: null
	};
}
function countXPathMatchesMainWorld(rawXp) {
	return countXPathMatches(rawXp, { pierceShadow: true });
}
//#endregion
//#region dom/locatorScripts/cursorOverlay.ts
var CURSOR_OVERLAY_ID = "__v3_cursor_overlay__";
var cursorElement = null;
var pendingPosition = null;
var installScheduled = false;
function positionCursor(element, x, y) {
	element.style.left = `${Math.max(0, x)}px`;
	element.style.top = `${Math.max(0, y)}px`;
}
function scheduleInstall() {
	if (installScheduled) return;
	installScheduled = true;
	const retry = () => {
		installScheduled = false;
		installCursorOverlay();
	};
	document.addEventListener("DOMContentLoaded", retry, { once: true });
	globalThis.setTimeout(retry, 100);
}
function installCursorOverlay() {
	try {
		if (cursorElement?.isConnected) return true;
		const existing = document.getElementById(CURSOR_OVERLAY_ID);
		if (existing instanceof HTMLDivElement) cursorElement = existing;
		else {
			const root = document.documentElement ?? document.body ?? document.head;
			if (!root) {
				scheduleInstall();
				return false;
			}
			const element = document.createElement("div");
			element.id = CURSOR_OVERLAY_ID;
			element.style.position = "fixed";
			element.style.left = "0px";
			element.style.top = "0px";
			element.style.width = "16px";
			element.style.height = "24px";
			element.style.zIndex = "2147483647";
			element.style.pointerEvents = "none";
			element.style.userSelect = "none";
			element.style.mixBlendMode = "normal";
			element.style.contain = "layout style paint";
			element.style.willChange = "transform,left,top";
			element.innerHTML = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"24\" viewBox=\"0 0 16 24\"><path d=\"M1 0 L1 22 L6 14 L15 14 Z\" fill=\"black\" stroke=\"white\" stroke-width=\"0.7\"/></svg>";
			root.appendChild(element);
			cursorElement = element;
		}
		if (pendingPosition) {
			positionCursor(cursorElement, pendingPosition[0], pendingPosition[1]);
			pendingPosition = null;
		}
		return true;
	} catch {
		return false;
	}
}
function moveCursorOverlay(x, y) {
	pendingPosition = [x, y];
	if (!installCursorOverlay() || !cursorElement) return false;
	positionCursor(cursorElement, x, y);
	pendingPosition = null;
	return true;
}
//#endregion
//#region dom/locatorScripts/selectors.ts
var parseTargetIndex = (value) => {
	const num = Number(value ?? 0);
	if (!Number.isFinite(num) || num < 0) return 0;
	return Math.floor(num);
};
var collectCssMatches = (selector, limit) => {
	if (!selector) return [];
	const seenRoots = /* @__PURE__ */ new WeakSet();
	const seenElements = /* @__PURE__ */ new Set();
	const results = [];
	const queue = [document];
	const visit = (root) => {
		if (!root || seenRoots.has(root) || results.length >= limit) return;
		seenRoots.add(root);
		try {
			const matches = root.querySelectorAll(selector);
			for (const element of matches) {
				if (seenElements.has(element)) continue;
				seenElements.add(element);
				results.push(element);
				if (results.length >= limit) return;
			}
		} catch {}
		try {
			const walker = (root instanceof Document ? root : root.host?.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
			let node;
			while (node = walker.nextNode()) {
				if (!(node instanceof Element)) continue;
				const shadowRoot = getOpenOrClosedShadowRoot(node);
				if (shadowRoot) queue.push(shadowRoot);
			}
		} catch {}
	};
	while (queue.length && results.length < limit) {
		const next = queue.shift();
		if (next) visit(next);
	}
	return results;
};
function resolveCssSelector(selectorRaw, targetIndexRaw) {
	const selector = String(selectorRaw ?? "").trim();
	if (!selector) return null;
	const targetIndex = parseTargetIndex(targetIndexRaw);
	return collectCssMatches(selector, targetIndex + 1)[targetIndex] ?? null;
}
function resolveTextSelector(rawNeedle, targetIndexRaw) {
	const needle = String(rawNeedle ?? "");
	if (!needle) return null;
	const needleLc = needle.toLowerCase();
	const targetIndex = parseTargetIndex(targetIndexRaw);
	const skipTags = /* @__PURE__ */ new Set([
		"SCRIPT",
		"STYLE",
		"TEMPLATE",
		"NOSCRIPT",
		"HEAD",
		"TITLE",
		"LINK",
		"META",
		"HTML",
		"BODY"
	]);
	const shouldSkip = (node) => {
		if (!node) return false;
		const tag = node.tagName?.toUpperCase() ?? "";
		return skipTags.has(tag);
	};
	const extractText = (node) => {
		try {
			if (shouldSkip(node)) return "";
			const inner = node.innerText;
			if (typeof inner === "string" && inner.trim()) return inner.trim();
		} catch {}
		try {
			const text = node.textContent;
			if (typeof text === "string") return text.trim();
		} catch {}
		return "";
	};
	const matches = (node) => {
		const text = extractText(node);
		return !!text && text.toLowerCase().includes(needleLc);
	};
	const seen = /* @__PURE__ */ new WeakSet();
	const queue = [];
	const matchesList = [];
	const enqueue = (node) => {
		if (!node || seen.has(node)) return;
		seen.add(node);
		queue.push(node);
	};
	const walkerFor = (root) => {
		try {
			return (root instanceof Document ? root : root?.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
		} catch {
			return null;
		}
	};
	enqueue(document);
	while (queue.length) {
		const root = queue.shift();
		if (!root) continue;
		if (root instanceof Element && matches(root)) matchesList.push({
			element: root,
			tag: root.tagName ?? "",
			id: root.id ?? "",
			className: root.className ?? "",
			text: extractText(root)
		});
		const walker = walkerFor(root);
		if (!walker) continue;
		let node;
		while (node = walker.nextNode()) {
			if (!(node instanceof Element)) continue;
			if (matches(node)) matchesList.push({
				element: node,
				tag: node.tagName ?? "",
				id: node.id ?? "",
				className: node.className ?? "",
				text: extractText(node)
			});
			const shadowRoot = getOpenOrClosedShadowRoot(node);
			if (shadowRoot) enqueue(shadowRoot);
		}
	}
	const innermost = [];
	for (const item of matchesList) {
		const el = item.element;
		let skip = false;
		for (const other of matchesList) {
			if (item === other) continue;
			try {
				if (el.contains(other.element)) {
					skip = true;
					break;
				}
			} catch {}
		}
		if (!skip) innermost.push(item);
	}
	return innermost[targetIndex]?.element ?? null;
}
function resolveXPathMainWorld(rawXp, targetIndexRaw) {
	return resolveXPathAtIndex(rawXp, parseTargetIndex(targetIndexRaw), { pierceShadow: true });
}
//#endregion
//#region dom/locatorScripts/waitForSelector.ts
/**
* waitForSelector - Waits for an element matching a selector to reach a specific state.
* Supports both CSS selectors and XPath expressions.
* Uses MutationObserver for efficiency and the extension DOM API for closed shadow roots.
*
* NOTE: This function runs inside the page context. Keep it dependency-free
* and resilient to exceptions.
*/
/**
* Check if a selector is an XPath expression.
*/
var isXPath = (selector) => {
	return selector.startsWith("xpath=") || selector.startsWith("/");
};
/**
* Deep querySelector that pierces both open and closed shadow DOM.
*/
var deepQuerySelector = (root, selector, pierceShadow) => {
	try {
		const el = root.querySelector(selector);
		if (el) return el;
	} catch {}
	if (!pierceShadow) return null;
	const seenRoots = /* @__PURE__ */ new WeakSet();
	const queue = [root];
	while (queue.length > 0) {
		const currentRoot = queue.shift();
		if (!currentRoot || seenRoots.has(currentRoot)) continue;
		seenRoots.add(currentRoot);
		try {
			const found = currentRoot.querySelector(selector);
			if (found) return found;
		} catch {}
		try {
			const walker = (currentRoot instanceof Document ? currentRoot : currentRoot.host?.ownerDocument ?? document).createTreeWalker(currentRoot, NodeFilter.SHOW_ELEMENT);
			let node;
			while (node = walker.nextNode()) {
				if (!(node instanceof Element)) continue;
				const shadowRoot = getOpenOrClosedShadowRoot(node);
				if (shadowRoot && !seenRoots.has(shadowRoot)) queue.push(shadowRoot);
			}
		} catch {}
	}
	return null;
};
/**
* Resolve XPath with shadow DOM piercing support.
*/
var deepXPathQuery = (xpath, pierceShadow) => {
	return resolveXPathFirst(xpath, { pierceShadow });
};
/**
* Find element by selector (CSS or XPath) with optional shadow DOM piercing.
*/
var findElement = (selector, pierceShadow) => {
	if (isXPath(selector)) return deepXPathQuery(selector, pierceShadow);
	return deepQuerySelector(document, selector, pierceShadow);
};
/**
* Check if element matches the desired state.
*/
var checkState = (el, state) => {
	if (state === "detached") return el === null;
	if (state === "attached") return el !== null;
	if (el === null) return false;
	if (state === "hidden") try {
		const style = window.getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		return style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || rect.width === 0 || rect.height === 0;
	} catch {
		return false;
	}
	try {
		const style = window.getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
	} catch {
		return false;
	}
};
/**
* Set up MutationObservers on all shadow roots to detect changes.
*/
var setupShadowObservers = (callback, observers) => {
	const seenRoots = /* @__PURE__ */ new WeakSet();
	const observeShadowRoots = (node) => {
		const shadowRoot = getOpenOrClosedShadowRoot(node);
		if (shadowRoot && !seenRoots.has(shadowRoot)) {
			seenRoots.add(shadowRoot);
			const shadowObserver = new MutationObserver(() => {
				callback();
				scan();
			});
			shadowObserver.observe(shadowRoot, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: [
					"style",
					"class",
					"hidden",
					"disabled"
				]
			});
			observers.push(shadowObserver);
			for (const child of Array.from(shadowRoot.children)) observeShadowRoots(child);
		}
		for (const child of Array.from(node.children)) observeShadowRoots(child);
	};
	const root = document.documentElement || document.body;
	const scan = () => {
		if (root) observeShadowRoots(root);
	};
	scan();
	return scan;
};
/**
* Wait for an element matching the selector to reach the specified state.
* Supports both CSS selectors and XPath expressions (prefix with "xpath=" or start with "/").
*
* @param selectorRaw - CSS selector or XPath expression to wait for
* @param stateRaw - Element state: 'attached' | 'detached' | 'visible' | 'hidden'
* @param timeoutRaw - Maximum time to wait in milliseconds
* @param pierceShadowRaw - Whether to search inside shadow DOM
* @returns Promise that resolves to true when condition is met, or rejects on timeout
*/
function waitForSelector(selectorRaw, stateRaw, timeoutRaw, pierceShadowRaw) {
	const selector = String(selectorRaw ?? "").trim();
	const state = String(stateRaw ?? "visible") || "visible";
	const timeout = typeof timeoutRaw === "number" && timeoutRaw > 0 ? timeoutRaw : 3e4;
	const pierceShadow = pierceShadowRaw !== false;
	return new Promise((resolve, reject) => {
		let timeoutId = null;
		let domReadyHandler = null;
		let settled = false;
		const clearTimer = () => {
			if (timeoutId !== null) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}
		};
		if (checkState(findElement(selector, pierceShadow), state)) {
			settled = true;
			resolve(true);
			return;
		}
		const observers = [];
		let shadowScanInterval = null;
		let rescanShadowRoots = null;
		const cleanup = () => {
			for (const obs of observers) obs.disconnect();
			if (shadowScanInterval !== null) {
				clearInterval(shadowScanInterval);
				shadowScanInterval = null;
			}
			if (domReadyHandler) {
				document.removeEventListener("DOMContentLoaded", domReadyHandler);
				domReadyHandler = null;
			}
		};
		const check = () => {
			if (settled) return;
			if (checkState(findElement(selector, pierceShadow), state)) {
				settled = true;
				clearTimer();
				cleanup();
				resolve(true);
			}
		};
		if (!(document.body || document.documentElement)) {
			domReadyHandler = () => {
				document.removeEventListener("DOMContentLoaded", domReadyHandler);
				domReadyHandler = null;
				check();
				setupObservers();
			};
			document.addEventListener("DOMContentLoaded", domReadyHandler);
			timeoutId = setTimeout(() => {
				if (settled) return;
				settled = true;
				clearTimer();
				cleanup();
				reject(/* @__PURE__ */ new Error(`waitForSelector: Timeout ${timeout}ms exceeded waiting for "${selector}" to be ${state}`));
			}, timeout);
			return;
		}
		const setupObservers = () => {
			const root = document.body || document.documentElement;
			if (!root) return;
			const mainObserver = new MutationObserver(() => {
				check();
				rescanShadowRoots?.();
			});
			mainObserver.observe(root, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: [
					"style",
					"class",
					"hidden",
					"disabled"
				]
			});
			observers.push(mainObserver);
			if (pierceShadow) {
				rescanShadowRoots = setupShadowObservers(check, observers);
				shadowScanInterval = setInterval(() => {
					rescanShadowRoots?.();
					check();
				}, 100);
			}
		};
		setupObservers();
		timeoutId = setTimeout(() => {
			if (settled) return;
			settled = true;
			clearTimer();
			cleanup();
			reject(/* @__PURE__ */ new Error(`waitForSelector: Timeout ${timeout}ms exceeded waiting for "${selector}" to be ${state}`));
		}, timeout);
	});
}
//#endregion
//#region dom/locatorScripts/registry.ts
var locatorScripts = Object.freeze({
	countCssMatchesPrimary,
	countTextMatches,
	countXPathMatchesMainWorld,
	getOpenOrClosedShadowRoot,
	installCursorOverlay,
	moveCursorOverlay,
	resolveCssSelector,
	resolveTextSelector,
	resolveXPathMainWorld,
	waitForSelector
});
//#endregion
//#region content-script.ts
var scope = globalThis;
if (!scope.__stagehandExtensionWorld) Object.defineProperty(scope, "__stagehandExtensionWorld", {
	configurable: false,
	enumerable: false,
	writable: false,
	value: Object.freeze({
		name: "stagehand",
		version: "stagehand.v4"
	})
});
if (!scope.__stagehandLocatorScripts) Object.defineProperty(scope, "__stagehandLocatorScripts", {
	configurable: false,
	enumerable: false,
	writable: false,
	value: locatorScripts
});
if (!scope.__stagehandLocatorWorld) {
	const closedShadowRoots = typeof globalThis.chrome?.dom?.openOrClosedShadowRoot === "function";
	Object.defineProperty(scope, "__stagehandLocatorWorld", {
		configurable: false,
		enumerable: false,
		writable: false,
		value: Object.freeze({
			kind: closedShadowRoots ? "extension" : "cdp-fallback",
			closedShadowRoots
		})
	});
}
//#endregion
