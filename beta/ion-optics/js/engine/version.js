/* ==========================================================================
   Ion optics engine: version.js
   Product name and the version numbers shared by the page, the workers and
   project files. The product name is written only here and in the two page
   titles. ENGINE_VERSION is bumped on any change to engine numerics or to the
   typed-array layouts; it is part of every cache key and of the worker
   handshake, so a page and a worker from different deployments never mix.
   No external sources (plain constants).
   ========================================================================== */

/** Working product name (final name to be approved). */
export const PRODUCT_NAME = 'Ion Optics Workbench';
/** Engine version: bump on any numerics or layout change. */
export const ENGINE_VERSION = '0.1.0';
/** Worker message protocol version (spec §2.4). */
export const PROTOCOL_VERSION = 1;
/** Value of the `format` field of a project file. */
export const PROJECT_FORMAT = 'ion-optics-project';
