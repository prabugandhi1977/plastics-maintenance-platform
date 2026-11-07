// Where this app is served from: the site root on its own, or /monitor/ when MouldCare serves it. Every API call and
// shareable link is built from the address of the page, so the app works under either.
export const BASE = new URL('./', document.baseURI).pathname;
export const API = BASE + 'api';
