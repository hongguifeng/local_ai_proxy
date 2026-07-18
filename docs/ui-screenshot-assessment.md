# UI Screenshot Assessment

The Node admin UI intentionally preserves the existing Proxy and History layouts. Automated Chrome
visual tests compare all four checked-in Chinese/English screenshots against the migrated UI, and the
current images remain within the approved pixel-difference thresholds. The responsive 760 px layout is
also covered separately.

No screenshot replacement is required for this release. Replacing the files without a user-visible UI
change would only introduce rendering-environment noise.
