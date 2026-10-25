/**
 * Registers _ts-hooks.mjs with Node's module system.
 *
 *   node --import ./scripts/_ts-hooks-register.mjs <script>
 *
 * Kept separate from the hook itself because `--import` takes an entry point, and
 * that entry point has to call `register()` before the script under test resolves
 * its first import.
 */

import { register } from "node:module";

register("./_ts-hooks.mjs", import.meta.url);
