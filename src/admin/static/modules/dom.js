/** @typedef {HTMLElement & Partial<HTMLInputElement> & Partial<HTMLTextAreaElement> & Partial<HTMLDialogElement> & Partial<HTMLDetailsElement>} DomElement */

/**
 * @param {string} selector
 * @param {ParentNode} root
 * @returns {Element | null}
 */
export function optionalElement(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * @param {string} selector
 * @param {ParentNode} root
 * @returns {Element}
 */
export function requiredElement(selector, root = document) {
  const element = optionalElement(selector, root);
  if (element === null) {
    throw new Error(`Required UI element not found: ${selector}`);
  }
  return element;
}

/** @param {string} id @returns {DomElement} */
export function $(id) {
  return /** @type {DomElement} */ (requiredElement(`#${CSS.escape(id)}`));
}

/** @param {string} selector @returns {DomElement | null} */
export function qs(selector) {
  return /** @type {DomElement | null} */ (optionalElement(selector));
}

/** @param {string} selector @returns {DomElement[]} */
export function qsa(selector) {
  return /** @type {DomElement[]} */ (Array.from(document.querySelectorAll(selector)));
}

/** @param {Element} root @param {string} selector @returns {DomElement[]} */
export function qsaOn(root, selector) {
  return /** @type {DomElement[]} */ (Array.from(root.querySelectorAll(selector)));
}

/** @param {Element} root @param {string} selector @returns {DomElement | null} */
export function qsOn(root, selector) {
  return /** @type {DomElement | null} */ (optionalElement(selector, root));
}

/** @param {string} id @returns {HTMLInputElement} */
export function requiredInput(id) {
  const element = requiredElement(`#${CSS.escape(id)}`);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Required UI input has wrong element type: #${id}`);
  }
  return element;
}

/** @param {string} id @returns {HTMLDialogElement} */
export function requiredDialog(id) {
  const element = requiredElement(`#${CSS.escape(id)}`);
  if (!(element instanceof HTMLDialogElement)) {
    throw new Error(`Required UI dialog has wrong element type: #${id}`);
  }
  return element;
}

/** @param {string} id @returns {HTMLDetailsElement} */
export function requiredDetails(id) {
  const element = requiredElement(`#${CSS.escape(id)}`);
  if (!(element instanceof HTMLDetailsElement)) {
    throw new Error(`Required UI details has wrong element type: #${id}`);
  }
  return element;
}

/** @param {EventTarget | null} target @returns {DomElement | null} */
export function asElement(target) {
  return target instanceof Element ? /** @type {DomElement} */ (target) : null;
}

/** @param {EventTarget | null} target @param {string} selector @returns {DomElement | null} */
export function closestFrom(target, selector) {
  return asElement(target)?.closest(selector) ?? null;
}

/** @param {Element | null | undefined} root @param {string} selector @returns {DomElement | null} */
export function closestOn(root, selector) {
  return root?.closest(selector) ?? null;
}

/** @param {Element | null | undefined} element @returns {DomElement | null} */
export function parentOf(element) {
  return element?.parentElement ?? null;
}
