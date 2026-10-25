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

/** @param {string} id @returns {HTMLElement} */
export function $(id) {
  const element = optionalId(id);
  if (element === null) throw new Error(`Required UI element not found: #${id}`);
  return element;
}

/** @param {string} id @returns {HTMLElement | null} */
export function optionalId(id) {
  return qs(`#${CSS.escape(id)}`);
}

/**
 * Query a concrete element class. A present node of the wrong class is a markup
 * contract error, even when absence is allowed.
 * @template {Element} T
 * @param {string} selector
 * @param {{new(): T}} type
 * @param {ParentNode} [root]
 * @returns {T | null}
 */
export function optionalTyped(selector, type, root = document) {
  const element = optionalElement(selector, root);
  if (element === null) return null;
  if (element instanceof type) return element;
  {
    throw new Error(`UI element has wrong element type: ${selector} (expected ${type.name})`);
  }
}

/**
 * @template {Element} T
 * @param {string} selector
 * @param {{new(): T}} type
 * @param {ParentNode} [root]
 * @returns {T}
 */
export function requiredTyped(selector, type, root = document) {
  const element = optionalTyped(selector, type, root);
  if (element === null) throw new Error(`Required UI element not found: ${selector}`);
  return element;
}

/** @param {string} selector @returns {HTMLElement | null} */
export function qs(selector) {
  return optionalTyped(selector, HTMLElement);
}

/** @param {string} selector @returns {HTMLElement[]} */
export function qsa(selector) {
  return qsaOn(document, selector);
}

/** @param {ParentNode} root @param {string} selector @returns {HTMLElement[]} */
export function qsaOn(root, selector) {
  return Array.from(root.querySelectorAll(selector)).map((element) => {
    if (!(element instanceof HTMLElement))
      throw new Error(`UI element has wrong element type: ${selector}`);
    return element;
  });
}

/** @param {Element} root @param {string} selector @returns {HTMLElement | null} */
export function qsOn(root, selector) {
  return optionalTyped(selector, HTMLElement, root);
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

/** @param {EventTarget | null} target @returns {HTMLElement | null} */
export function asElement(target) {
  return target instanceof HTMLElement ? target : null;
}

/** @param {EventTarget | null} target @param {string} selector @returns {HTMLElement | null} */
export function closestFrom(target, selector) {
  return closestOn(asElement(target), selector);
}

/** @param {Element | null | undefined} root @param {string} selector @returns {HTMLElement | null} */
export function closestOn(root, selector) {
  const element = root?.closest(selector);
  if (element == null) return null;
  if (!(element instanceof HTMLElement))
    throw new Error(`UI element has wrong element type: ${selector}`);
  return element;
}

/** @param {Element | null | undefined} element @returns {HTMLElement | null} */
export function parentOf(element) {
  return element?.parentElement ?? null;
}

/** @param {ParentNode} root @param {string} selector @returns {HTMLDetailsElement[]} */
export function detailsOn(root, selector) {
  return Array.from(root.querySelectorAll(selector)).map((element) => {
    if (!(element instanceof HTMLDetailsElement))
      throw new Error(`UI element has wrong element type: ${selector}`);
    return element;
  });
}

/** @typedef {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} FormControl */
/** @param {Element} element @returns {FormControl} */
export function formControl(element) {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  )
    return element;
  throw new Error(`UI element has wrong element type: ${element.tagName} (expected form control)`);
}
/** @param {ParentNode} root @param {string} selector @returns {FormControl[]} */
export function controlsOn(root, selector) {
  return Array.from(root.querySelectorAll(selector)).map(formControl);
}
