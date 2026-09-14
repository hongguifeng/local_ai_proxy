# UI Screenshot Assessment

The Node admin UI intentionally preserves the existing Proxy and History layouts. Automated Chrome
visual tests compare all six checked-in Chinese/English screenshots (Proxy, History, and Usage
statistics) against the migrated UI, and the current images remain within the approved
pixel-difference thresholds. The responsive 760 px layout is also covered separately.

No screenshot replacement is required for the existing Proxy and History baselines. Replacing those
files without a user-visible UI change would only introduce rendering-environment noise. The Usage
statistics baselines are new and were captured together with the statistics feature.
