/**
 * The catalog entry 0.1.0 does not ship, as a fixture the install path can still be tested against.
 *
 * `catalog/connectors.json` is empty in this release on purpose (#151), and `readCatalog`/`catalogEntry` keep their one
 * reader. A test that starts from an *entry* — the planner, the apply path, the compose renderer — names this file
 * instead, so the mechanism stays pinned while the shipped list says nothing.
 */
import { join } from "node:path";

/** A file with the one entry the catalog used to hold: telegram, pinned to the image this release cannot pull. */
export const TELEGRAM_CATALOG = join(import.meta.dirname, "telegram-catalog.json");
