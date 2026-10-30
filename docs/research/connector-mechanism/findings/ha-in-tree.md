# How does Home Assistant keep thousands of in-tree, code-level integrations from rotting, and what exactly does an integration have to declare and implement?

## Answer
An in-tree Home Assistant integration is a Python package `homeassistant/components/<domain>/` whose `manifest.json` is read before any of its code loads, and whose features are found by *file name* (`config_flow.py`, `sensor.py`, `diagnostics.py`, `repairs.py`) — a closed, hard-coded interface set, not a runtime registration. The host owns the lifecycle: the integration implements `async_setup_entry` / `async_unload_entry` / `async_migrate_entry` and raises three named exceptions, and Home Assistant does the retrying, re-auth, unload and cleanup. What stops the set from rotting is not review alone but converting every quality claim into a machine-checked artifact: a 54-rule quality scale recorded per integration in `quality_scale.yaml`, enforced by hassfest in CI and by a core pylint plugin whose checks fire off the integration's own claims, plus a mandatory owner in `codeowners` that hassfest also uses to generate `CODEOWNERS`, plus a 6-month (user-facing) / 12-month (developer-facing) deprecation floor with `breaks_in_ha_version` named up front. Out-of-tree code (custom_components / HACS / the new built-in Marketplace, 2026.11) is the *same* manifest and the *same* shape — "They are built the same way, with two differences in the manifest" — minus the review, the shared translations, and anyone obligated to fix it when core moves.

## Claims

### 1. The manifest: every field an integration declares, and what it is for

Format is itself policed: "Hassfest, the validation script of core, checks every manifest. It requires the keys to be sorted: domain, then name, then everything else in alphabetical order." [1] — direct. "Home Assistant reads it before it loads any code." [1] — direct.

Required keys:
- **domain** — "The short, unique name of the integration, made of lowercase letters, numbers, and underscores, like mobile_app." … "it can never change: config entries, entity IDs, and user automations all refer to it." [1] — direct.
- **name** — "The name users see. Use the name of the product or service" [1] — direct.
- **codeowners** — "A list of GitHub usernames or team names, like ["@frenck"], of the people responsible for the integration." + "Integrations at the Silver tier of the quality scale and above must have at least one integration owner." [1] — direct.
- **documentation** — "The URL of the documentation. For integrations in core, this is https://www.home-assistant.io/integrations/<domain>." [1] — direct.
- **iot_class** — "The IoT class: how the integration talks to the device or service." Values: `local_polling`, `local_push`, `cloud_polling`, `cloud_push`, `assumed_state`, `calculated`. [1] — direct.

Setup and type:
- **integration_type** — "What the integration is about. Integrations in core with a config flow must set it." Values `device|hub|service|helper|entity|hardware|system|virtual`; "When it is missing, Home Assistant treats the integration as a hub, but set it anyway." [1] — direct.
- **categories** — "The categories people find the integration by, on the integrations page of the website, in the app, and in the Marketplace." One to three entries; hassfest checks they are known and not a category next to its own subcategory. [1] — direct.
- **config_flow** — "Set "config_flow": true when the integration has a config_flow.py, so users can add it from the UI." [1] — direct.
- **single_config_entry** — "Set "single_config_entry": true when the integration supports only one config entry. Home Assistant then stops users from adding a second one." [1] — direct.

Dependencies:
- **requirements** — "A list of Python packages the integration needs, in pip format and pinned to an exact version" … "Home Assistant installs them before it loads the integration. If installing fails, the integration does not load." [1] — direct.
- **dependencies** — "Other integrations that must be set up before this one loads." + "It does not guarantee that the config entries of the other integration are set up yet." [1] — direct.
- **after_dependencies** — "Integrations your integration can use, but does not need." [1] — direct.
- **loggers** — "A list of the logger names your requirements use in their logging.getLogger calls" [1] — direct.

Quality and status:
- **quality_scale** — "The tier of the integration quality scale the integration reaches: bronze, silver, gold, or platinum. New integrations must reach at least bronze." [1] — direct.
- **disabled** — "A short reason that keeps the integration from loading, like "Library is broken with the latest firmware". Home Assistant logs the reason." [1] — direct.
- **preview_features** — "Labs preview features the integration offers: experimental features that users turn on themselves" [1] — direct.

Discovery matchers (each starts the config flow at a step named after the source): **bluetooth** ("A list of matchers. A device matches when it matches every key of at least one matcher."), **zeroconf** ("A list of mDNS service types."), **ssdp** ("A list of matchers on the SSDP headers st, usn, ext, and server (in lowercase)"), **homekit** ("Model names of HomeKit devices."), **lorawan**, **mqtt** ("A list of MQTT topics to subscribe to for discovery."), **dhcp**, **usb** ("A list of matchers on USB devices: vid and pid (uppercase)"). [1] — direct.

Custom-integration-only keys: **version** ("required. A version that AwesomeVersion understands, like "1.2.0" (SemVer) or "2026.10.1" (CalVer)"), **issue_tracker**, **import_executor** ("Home Assistant imports integrations in an executor, so a slow import does not block the event loop."). [1] — direct.

Virtual integrations are "only a manifest, without any code, and only integrations in core can provide one", keyed by `supported_by` or `iot_standards`. [1] — direct.

### 2. The config entry lifecycle, and what the host guarantees

- A config entry is "one set-up instance of an integration, like one Hue bridge or one account"; it holds `data` (connect config, static), `options` (user-changeable), `subentries`, `unique_id`, and `runtime_data` ("whatever your integration needs while it runs. It is not stored."). [2] — direct.
- States are an explicit enum the host owns: `NOT_LOADED`, `SETUP_IN_PROGRESS`, `LOADED`, `SETUP_ERROR`, `SETUP_RETRY`, `MIGRATION_ERROR`, `UNLOAD_IN_PROGRESS`, `FAILED_UNLOAD`. [2] — direct.
- Setup is host-driven per entry: "Then it calls async_setup_entry in your __init__.py for every config entry, except the ones the user disabled or ignored." "async_setup_entry returns nothing. When it returns, the setup succeeded, and the entry is LOADED." [2] — direct.
- Runtime data has a designated home: "Store what your integration needs while it runs, like the API client or the coordinator, in entry.runtime_data." and "Do not use hass.data for data that belongs to a config entry." [2] — direct.
- Failure is classified by exception, and the host owns the response: `ConfigEntryNotReady` → "Puts the entry in SETUP_RETRY, and retries with a growing delay, up to 10 minutes"; `ConfigEntryAuthFailed` → "Puts the entry in SETUP_ERROR, and starts a reauthentication flow"; `ConfigEntryError` → "Puts the entry in SETUP_ERROR, and does not retry". [7] — direct. And: "You do not write retry loops for that: you raise the right exception, and Home Assistant does the rest." [7] — direct.
- Raising from the wrong place is silently degraded: "A platform's async_setup_entry runs too late: when it raises ConfigEntryNotReady, ConfigEntryAuthFailed, or ConfigEntryError, Home Assistant only logs an error and skips that platform." [7] — direct.
- Unload/reload is a first-class requirement: "Support unloading, so users can reload or disable an entry without restarting Home Assistant." Cleanup is registered rather than written: "Register it while setting up, and Home Assistant runs it when the entry unloads" via `entry.async_on_unload(...)`. [2] — direct. Background tasks are cancelled too: "Home Assistant cancels them when the entry unloads, so they never outlive the entry." [2] — direct.
- Mutation goes through the host: "Never change the attributes of a ConfigEntry directly. Call async_update_entry instead." [2] — direct.
- Migration is versioned in the data, not in the code: entries carry a major `VERSION` and `MINOR_VERSION` (both default 1); "A minor version bump is backwards compatible." and "A major version bump is not." Home Assistant calls `async_migrate_entry` "when the stored major version is older than your config flow's, or when the major version is the same and the minor version differs", and crucially "An entry with a newer major version than your config flow fails to set up without calling your code." [2] — direct.
- `MIGRATION_ERROR` is sticky: "MIGRATION_ERROR does not recover by itself." [2] — direct.
- Removal is a hook plus host-side cleanup: `async_remove_entry`, and "You do not need async_remove_entry to clean up the devices and entities of the entry, or the repair issues that belong to it. Home Assistant removes them for you." [2] — direct.
- State changes are observable: `entry.async_on_state_change(callback)` returning an unsubscribe function. [2] — direct.

### 3. The contribution points, and whether a platform is a fixed interface or a registration

- The whole feature set is found **by file name**: "Home Assistant finds most features of an integration by file name, so the names below matter." [3] — direct. And: "Some files are integration platforms: Home Assistant loads them by name when the feature they provide is needed. You add the file, and the feature appears." [3] — direct.
- The platform file list is closed and enumerated: `diagnostics.py`, `system_health.py`, `repairs.py`, `reproduce_state.py`, `significant_change.py`, `backup.py`, `media_source.py`, `application_credentials.py`, `device_trigger.py` / `device_condition.py` / `device_action.py`, plus one file per entity platform (`light.py`, `sensor.py`, …). [3] — direct.
- Entity platforms are a fixed interface, not a registration: "Entities come in domains, like sensor, light, or climate. Each domain is an entity platform: a base class with its own properties, features, and states, that every integration implements in the same way." [4] — direct. "A platform is how your integration provides one type of entity. To provide sensors, you add sensor.py." [5] — direct. Fixed by code: `PLATFORMS = [Platform.SENSOR, Platform.SWITCH]` and `hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)`. [2] — direct.
- The set is policed at the architecture level, not extended by plugins: "If no platform fits, or a platform misses something many devices have, don't work around it with attributes. Propose a change in the architecture discussions first." [4] — direct.
- Actions/services, by contrast, **are** runtime registrations: "Register actions in async_setup of your integration, not in async_setup_entry and not in a platform. That way they exist even when no config entry is loaded" — a Bronze rule. [6] — direct. `hass.services.async_register(DOMAIN, "get_forecast", handler, schema=...)`; entity-targeted ones via `async_register_platform_entity_service`; admin-only ones via `async_register_admin_service`, which "checks that the user of the call is an admin before your handler runs". [6] — direct.
- Discovery is host-side, declared as manifest data: "Your integration does not search the network itself. Home Assistant runs the discovery integrations, like zeroconf and dhcp, and checks what they find against the matchers in the manifests of all integrations." [8] — direct. The discovered device then enters the config flow at a source-named step (`async_step_zeroconf`, `async_step_dhcp`, …). [8] — direct.
- Diagnostics is a hook in a named file: "Create diagnostics.py, and implement one or both of these functions: async_get_config_entry_diagnostics / async_get_device_diagnostics". Redaction is the integration's duty via `async_redact_data`. [9] — direct.
- Repairs is a host-owned issue registry the integration writes into: `ir.async_create_issue(...)` with `breaks_in_ha_version`, `is_fixable`, `severity`, `translation_key`; "A repair issue tells users about something that needs their attention" and issues can belong to a config entry and are deleted with it. [21][16] — direct.

### 4. The mechanism that keeps the set from rotting

- The scale is the explicit anti-rot device, and it exists because of volume: "Home Assistant has thousands of integrations, written by thousands of people. The integration quality scale is how the project describes, in one word, how good each of them is: Bronze, Silver, Gold, or Platinum." [10] — direct.
- Tier semantics: "An integration earns a tier by following every rule of that tier and of the tiers below it." [10] — direct. "New integrations must reach Bronze. There is no way into core below it." [10] — direct. Rule counts: "The quality scale has 54 rules: 20 for Bronze, 10 for Silver, 21 for Gold, and 3 for Platinum." [11] — direct.
- Per-integration claim file: "An integration with a tier also has a quality_scale.yaml file. It lists every rule and its status: done, todo, or exempt with a reason." [10] — direct. "The file must list every rule of the scale, also the rules of tiers above the current tier. Hassfest rejects a file with a missing or unknown rule." [12] — direct.
- Enforcement is layered, and the strongest layer is claim→lint-rule: "Hassfest runs in CI on every pull request" and checks the tier's rules are done/exempt plus code-level facts for 7 named rules (`config-flow`, `discovery`, `reconfiguration-flow`, `runtime-data`, `strict-typing`, `test-before-setup`, `unique-config-entry`). [12] — direct. Then: "Core has its own pylint plugin, in pylint/plugins/ of the core repository. Some of its checks only run for integrations that mark a rule as done." [12] — direct, followed by the design rationale: "This keeps a claim honest after it was made, also when other people change the code later" [12] — direct.
- Human review is reserved for what tools cannot judge: "Most rules cannot be checked by a tool. Is the polling interval appropriate? Does the documentation explain the use cases? A person decides that." Plus an automated reviewer that "checks the change against the rules the integration marks as done or exempt, and leaves a review comment on the line that breaks a rule." [12] — direct.
- Ownership is a manifest field with teeth in both directions: "Hassfest fails when an integration with a Silver, Gold, or Platinum tier in its manifest has no integration owner." and "Hassfest also checks that the CODEOWNERS file matches the manifests." [13] — direct; hassfest "also generates files from them, like CODEOWNERS and the lists in homeassistant/generated/ of config flows, discovery information, and more." [14] — direct.
- Decay is expected and handled by demotion: "A tier is not forever. An integration can be moved down when it no longer follows the rules of its tier. A common reason is losing its last active integration owner" [15] — direct. And rule changes apply retroactively: "When a rule is added to a tier, the integrations on that tier need to follow it too." [15] — direct.
- Test requirement is a rule, not a convention: Silver's `test-coverage` = "The tests cover more than 95% of every module of the integration."; Bronze's `config-flow-test-coverage` = "The config flow has full test coverage, including recovery from errors." Tests live "outside the integration folder, in tests/components/<domain>/". [11][3] — direct.
- Naming the un-graded is itself controlled: `internal` integrations are listed in `script/hassfest/quality_scale.py`, and "Older integrations without one are listed in script/hassfest/quality_scale.py, and that list only gets shorter." [10][12] — direct. `legacy` = "older integrations, some of them as old as Home Assistant itself, that can only be set up with YAML." [15] — direct.
- The breaking-change policy is a two-speed floor: "Users: YAML configuration, actions, entities, attributes, integrations | 6 months" and "Developers: constants, helpers, entity properties, platform APIs that custom integrations use | 12 months". [16] — direct. "A deprecation period can be extended when the ecosystem has not caught up yet, but it is never shortened." and the removal release is named up front: "Name the release in which the removal happens as breaks_in_ha_version, in the version format, like "2027.1.0"." [16] — direct.
- What counts as the public integration API is defined by importability: "Anything that other integrations import or subclass is a core API: everything in homeassistant/helpers/, homeassistant/const.py, and entity platforms like homeassistant/components/sensor/." [16] — direct.
- Developer-facing breakage is announced to the *offending caller*, not the user: `report_usage()` "finds the responsible integration by walking the call stack", with `core_behavior` / `core_integration_behavior` / `custom_integration_behavior` (IGNORE / LOG / ERROR) defaults, because "users cannot fix the code of a custom integration." [16] — direct. Shims exist as library code: `DeprecatedConstant`, `DeprecatedConstantEnum`, `DeprecatedAlias`, `EnumWithDeprecatedMembers`, `@deprecated_function(..., breaks_in_ha_version=...)`. [16] — direct.
- Killing an integration is a documented procedure, not a delete: "Strip it down to a stub that raises an ERROR issue, and keep a minimal config_flow.py, so existing entries still load and the user sees what happened", with translation key `integration_removed`. [16] — direct. A soft kill: "use WARNING with a breaks_in_ha_version, and abort the config flow with the reason deprecated, so nobody can add new entries." [16] — direct. A blunt instrument exists too: manifest `disabled` — "A short reason that keeps the integration from loading". [1] — direct.
- Admission control keeps the set from growing faster than review capacity: "A new integration must reach the Bronze tier of the integration quality scale, and nothing more." with "One platform only, like just sensor." and "Big pull requests that dump a lot of code at once may be closed." Also three gates: product must be buyable, must have "an actual user base", and "All communication goes through a Python library on PyPI". [19] — direct.
- Core versioning is calendar-based and unrelated to plugins: `YYYY.MM.PATCH`, "The version is set in homeassistant/const.py"; compare with AwesomeVersion, "Do not parse the string yourself". [20] — direct.

### 5. Out of tree: custom_components, HACS, and the Marketplace — and what an author gives up

- Same code shape, same manifest, two loaders: "Home Assistant looks in two places: <config directory>/custom_components/<domain> and homeassistant/components/<domain>", and "They are built the same way, with two differences in the manifest: a custom integration needs a version, and its documentation points to its own documentation". [3][19] — direct. This is HA's own answer to "one manifest, two loaders".
- The override is real and dangerous: "A custom integration with the same domain as a built-in one overrides it." [3] — direct; "the catalog does not accept integrations that replace a core integration." [18] — direct.
- What the author gives up, per HA's own words: "custom is for custom integrations … The Home Assistant project does not review, maintain, or support them." [15] — direct; "Everything shared this way is made and supported by you, not by the Home Assistant project. Users see a warning that says so before they install anything from the Marketplace. Be ready to answer issues, and to update your work when Home Assistant changes." [17] — direct; "Custom integrations do not use strings.json, and are not translated on Lokalise." [18] — direct; brand assets go in a local `brand/` folder instead of the brands repo. [18] — direct.
- The deprecation promise still applies to them, but nobody fixes them: "Changes in core can break a custom integration. Changes to what custom integrations use from core, like helpers, constants, and entity properties, are deprecated for 12 months first, and announced on the blog." [18] — direct.
- Distribution changed under this: "The Marketplace is built into Home Assistant starting with 2026.11, under Settings > Marketplace. It grew out of HACS, the community store that people installed as a custom integration for years, and it uses the same catalog and the same hacs.json file." [17] — direct. (Checked 2026-10-30; this is a same-week change, dated by the site's blog index.)
- The recommended path is out-of-tree first, in-tree later: "For a new integration, the project recommends that you publish it in the Marketplace first, as a custom integration. You gain experience, and you can iterate faster." [19] — direct.
- Custom integrations do get CI-level checking from their own repo: the hassfest GitHub action "does" run the category checks, and "For a custom integration, an unknown category is a warning in hassfest instead of an error, so a category that changes in core doesn't fail hassfest in your repository. The HACS action does fail on an unknown category." [1] — direct.

### 6. Three concrete rules a smaller host could copy
- **Rule 1 — every declaration in the manifest must be either machine-checked or machine-generated; never a prose promise.** "Hassfest is the validator for integrations. It reads the files around your code, like manifest.json, strings.json, services.yaml, icons.json, and quality_scale.yaml, and checks that they are complete and consistent. It also generates files from them, like CODEOWNERS" [14] — direct. Copy: `codeowners` in the entry → a generated `CODEOWNERS` → routes review. Researcher inference: mason could derive a connector's owner/on-call from `integrations.json` the same way.
- **Rule 2 — make each quality claim a lint rule that fires only when the claim is made.** "Some of its checks only run for integrations that mark a rule as done." … "This keeps a claim honest after it was made, also when other people change the code later" [12] — direct. Copy: a connector that declares `owns-projection-entry` or `registers-tools` gets a static check that the registration still exists, so a refactor by a third party breaks CI rather than production.
- **Rule 3 — the host owns lifecycle; the plugin only classifies its own failure.** "You do not write retry loops for that: you raise the right exception, and Home Assistant does the rest." [7] — direct; "Home Assistant cancels them when the entry unloads, so they never outlive the entry." [2] — direct. Copy: a connector returns nothing and raises one of three typed failures; the host owns retry, re-auth, unload, and teardown — which is also how mason could keep a connector from leaking timers or listeners across a reload.

### 7. Two costs HA pays that mason could not afford
- **Cost 1 — the deprecation treadmill: every change to the extension API costs up to a year of dual code paths inside the tree.** "These deprecations get 12 months, and a post on the blog that names the replacement, if there is one, and the release of the removal." [16] — direct. The shims prove the cost: `DeprecatedConstantEnum`, `EnumWithDeprecatedMembers`, `@deprecated_function`, `report_usage()` with three per-audience behaviors, all shipped in core. [16] — direct. Researcher inference: this is affordable only because HA has a paid core team and a monthly release train; mason, with one operator and no release train, cannot carry a 12-month dual-path window per API change and should prefer an explicit version gate plus break-and-migrate.
- **Cost 2 — the artifacts-and-review tax per integration, which scales with the number of integrations.** "Most rules cannot be checked by a tool. Is the polling interval appropriate? Does the documentation explain the use cases? A person decides that." [12] — direct. Per integration that is: `manifest.json` + `__init__.py` + `config_flow.py` + `coordinator.py` + `entity.py` + one file per platform + `strings.json` + `icons.json` + `services.yaml` + `quality_scale.yaml` + a `tests/components/<domain>/` suite at 95% coverage + a page on home-assistant.io + brand assets in a separate repo. [3][11] — direct on the file list; Researcher inference: with a handful of connectors, mason pays the review tax for a set whose scale is 1/1000 of HA's, and the artifact set (10+ files per connector) would exceed the connector's own code.
- (Not counted, but relevant: HA also pays for a 20-rule minimum tier, an architecture-discussion process to change the interface set at all [4], and a per-release migration of thousands of integrations when a rule is added [15].)

## Sources
[1] The integration manifest — https://contributors.home-assistant.io/core/integrations/manifest/ — accessed 2026-10-30 — docs (page: "Last updated on October 20, 2026")
[2] Config entries — https://contributors.home-assistant.io/core/integrations/config-entries/ — accessed 2026-10-30 — docs (updated 2026-10-28)
[3] Integration file structure — https://contributors.home-assistant.io/core/integrations/file-structure/ — accessed 2026-10-30 — docs (updated 2026-10-13)
[4] Entities — https://contributors.home-assistant.io/core/entities/ — accessed 2026-10-30 — docs
[5] How an integration fits in — https://contributors.home-assistant.io/core/integrations/concepts/ — accessed 2026-10-30 — docs
[6] Actions — https://contributors.home-assistant.io/core/integrations/actions/ — accessed 2026-10-30 — docs
[7] Setup failures and exceptions — https://contributors.home-assistant.io/core/integrations/setup-failures/ — accessed 2026-10-30 — docs
[8] Discovery — https://contributors.home-assistant.io/core/integrations/discovery/ — accessed 2026-10-30 — docs
[9] Diagnostics — https://contributors.home-assistant.io/core/integrations/diagnostics/ — accessed 2026-10-30 — docs
[10] Integration quality scale (overview) — https://contributors.home-assistant.io/core/quality-scale/ — accessed 2026-10-30 — docs (updated 2026-10-13)
[11] All rules — https://contributors.home-assistant.io/core/quality-scale/rules/ — accessed 2026-10-30 — docs (updated 2026-10-12)
[12] The quality scale file — https://contributors.home-assistant.io/core/quality-scale/quality-scale-file/ — accessed 2026-10-30 — docs (updated 2026-10-16)
[13] Have an integration owner (Silver rule `integration-owner`) — https://contributors.home-assistant.io/core/quality-scale/integration-owner/ — accessed 2026-10-30 — docs
[14] Linters, hassfest, and CI — https://contributors.home-assistant.io/core/development/checks/ — accessed 2026-10-30 — docs (updated 2026-10-12)
[15] Tiers — https://contributors.home-assistant.io/core/quality-scale/tiers/ — accessed 2026-10-30 — docs (updated 2026-10-16)
[16] Deprecating — https://contributors.home-assistant.io/core/development/deprecating/ — accessed 2026-10-30 — docs (updated 2026-10-28)
[17] Marketplace — https://contributors.home-assistant.io/marketplace/ — accessed 2026-10-30 — docs (states Marketplace ships in 2026.11)
[18] Publish a custom integration — https://contributors.home-assistant.io/marketplace/guides/integrations/ — accessed 2026-10-30 — docs
[19] Create an integration (incl. "Does it belong in core?") — https://contributors.home-assistant.io/core/integrations/create/ — accessed 2026-10-30 — docs
[20] Versioning — https://contributors.home-assistant.io/core/development/versioning/ — accessed 2026-10-30 — docs (updated 2026-10-12)
[21] Repairs — https://contributors.home-assistant.io/core/integrations/repairs/ — accessed 2026-10-30 — docs

Rejected/deprioritized: the older `developers.home-assistant.io/docs/…` paths for quality scale and config flow — they now serve the site's 404/home shell (77,608 bytes, no article body), so they are dead ends; `developers.home-assistant.io/docs/creating_integration_manifest/` still serves the current content (identical byte size to the new `core/integrations/manifest/`), so the contributors subdomain is the canonical, dated copy. `developers.home-assistant.io/core/quality-scale/...` and `contributors.home-assistant.io/docs/...` cross-paths 404 — the tree has moved to `contributors.home-assistant.io/core/…`.
No secondary write-ups, blogs, or SEO content were used; every claim above comes from the doc tree itself.

## Conflicts
No disagreement between sources was found: every page comes from the same documentation tree, edited under one repo (`contributors.home-assistant.io`), and the pages are internally consistent on rule counts and tier semantics. Three tensions are worth recording rather than resolving:
1. **"No way into core below Bronze" vs. the existence of `legacy` and `no_score` integrations in core.** "New integrations must reach Bronze. There is no way into core below it." [10] versus "legacy is for older integrations, some of them as old as Home Assistant itself, that can only be set up with YAML." [15] — the invariant is enforced only for new arrivals (grandfathering), which is itself the anti-rot compromise: the policy is retroactive for *rules* ("When a rule is added to a tier, the integrations on that tier need to follow it too" [15]) but not for *admission*.
2. **"Not reviewed, maintained, or supported" vs. "checks a few things more strictly before it installs".** "The Home Assistant project does not review, maintain, or support them." [15] versus "though the Marketplace checks a few things more strictly before it installs" [17]. These are compatible (automated validation ≠ review) but the wording invites a reader to think out-of-tree code is vetted; it is not, it is only validated.
3. Minor: the tier-demotion rule has a carve-out that undercuts it slightly: "Integrations with devices in the Works with Home Assistant program keep their tier when that happens." [15] (i.e. when a rule is added). Not a source conflict, but it means tier enforcement is negotiable for commercial partners.
No conflicts found on the manifest field list, the config-entry state machine, or the deprecation periods — those appear in exactly one place each.

## Unanswered
- **The actual size of the in-tree set today.** Only the qualitative "thousands of integrations, written by thousands of people" [10] appears; no count of `homeassistant/components/*` was found on the doc site, and I did not enumerate the GitHub tree. If the report needs "N integrations", count directories in `home-assistant/core` via the GitHub API.
- **Whether a naive runtime registration path exists at all.** The docs describe file-name discovery and a fixed `Platform` enum, and they route any new entity kind to the architecture discussions [4]; I found no documented API by which an integration registers a *new* contribution kind at runtime. Unverified whether core internally has a generic platform registry — `homeassistant/components/*/manifest.json` + `async_forward_entry_setups` is all the docs show. Someone should read `homeassistant/config_entries.py` in core before this is quoted as "impossible".
- **Which CI jobs are required to merge, and whether hassfest failure blocks a merge mechanically.** [14][12] say hassfest runs in CI and fails, but the required-check configuration is in the repo settings, not the docs. Look at `.github/workflows` and branch protection in `home-assistant/core` if the argument needs "the merge is blocked".
- **The `quality_scale.yaml` schema as code** (allowed statuses per rule, the exempt-comment requirement) is documented [12] but not quoted from `script/hassfest/quality_scale.py`; the discount rate of exemptions across the tree is unknown.
- **Whether the in-process loader isolates a custom integration at all.** `import_executor` [1] says imports run in an executor so a slow import does not block the event loop — that is about blocking, not about privilege. I found no statement anywhere that a custom integration is sandboxed; the opposite is implied by "A custom integration with the same domain as a built-in one overrides it" [3], i.e. full in-process privilege. Worth one confirming read of `homeassistant/loader.py` before mason's trust argument leans on it.
- Not established: how many integrations are on each tier (the distribution), which would tell mason whether the 20-rule floor is actually achievable by volunteers. The honors/demotion history is not published in these pages.

## Queries
No `web_search` calls were made; the sub-question is fully answered by one enumerable primary documentation tree, so I fetched pages directly (all via `curl -sSL --max-time 20 --compressed` then `pandoc -f html -t plain`), and enumerated the site's own navigation links from the HTML rather than searching. URLs fetched:
- https://developers.home-assistant.io/docs/creating_integration_manifest/ (legacy path, current content)
- https://developers.home-assistant.io/docs/integration_quality_scale_index/
- https://developers.home-assistant.io/docs/quality_scale/ (dead — 404 shell)
- https://developers.home-assistant.io/sitemap.xml (dead — returns the 404 shell, no sitemap)
- https://developers.home-assistant.io/docs/{config_entries_index,config_flow_index,integration_quality_scale_tiers,integration_quality_scale_rules}/ (tiers/rules dead)
- https://contributors.home-assistant.io/core/integrations/manifest/
- https://contributors.home-assistant.io/core/integrations/config-entries/
- https://contributors.home-assistant.io/core/integrations/config-flow/
- https://contributors.home-assistant.io/core/integrations/file-structure/
- https://contributors.home-assistant.io/core/integrations/concepts/
- https://contributors.home-assistant.io/core/integrations/create/
- https://contributors.home-assistant.io/core/integrations/actions/
- https://contributors.home-assistant.io/core/integrations/setup-failures/
- https://contributors.home-assistant.io/core/integrations/discovery/
- https://contributors.home-assistant.io/core/integrations/diagnostics/
- https://contributors.home-assistant.io/core/integrations/repairs/
- https://contributors.home-assistant.io/core/entities/
- https://contributors.home-assistant.io/core/quality-scale/
- https://contributors.home-assistant.io/core/quality-scale/tiers/
- https://contributors.home-assistant.io/core/quality-scale/rules/
- https://contributors.home-assistant.io/core/quality-scale/quality-scale-file/
- https://contributors.home-assistant.io/core/quality-scale/integration-owner/
- https://contributors.home-assistant.io/core/development/checks/
- https://contributors.home-assistant.io/core/development/deprecating/
- https://contributors.home-assistant.io/core/development/versioning/
- https://contributors.home-assistant.io/marketplace/
- https://contributors.home-assistant.io/marketplace/guides/integrations/
- https://contributors.home-assistant.io/ (navigation enumeration)
Paths that returned the 404 shell (recorded so the next round does not retry them): `core/integrations/how-integrations-fit-in/`, `core/integrations/creating-integration/`, `core/entities/platforms/`, `core/development/linters/`, `core/development/hassfest/`, `core/development/hassfest-and-ci/`, `marketplace/publish/`.
