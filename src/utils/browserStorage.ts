/**
 * Safe wrappers around browser storage.
 *
 * The old `src/utils/clientOnlyFirebase.ts` also carried dynamic Firebase
 * auth/storage imports. After Phase 4 removed Firebase only these two plain
 * browser API wrappers remained, so they were extracted rather than keeping the
 * whole Firebase tree around for a sessionStorage wrapper.
 */

/** A localStorage stand-in that is safe to call during SSR */
const SSR_STORAGE_MOCK = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  length: 0,
  key: () => null,
};

export function isClientSide(): boolean {
  return typeof window !== 'undefined';
}

/**
 * Safely access localStorage only on client-side
 */
export function safeLocalStorage() {
  if (typeof window === 'undefined') {
    return SSR_STORAGE_MOCK;
  }
  return window.localStorage;
}

/**
 * Safely access sessionStorage only on client-side
 */
export function safeSessionStorage() {
  if (typeof window === 'undefined') {
    return SSR_STORAGE_MOCK;
  }
  return window.sessionStorage;
}