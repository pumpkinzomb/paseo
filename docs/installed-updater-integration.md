# Installed updater integration

This integration starts from main 81670544d, which contains remote main 1de1ebaed. It selects the installed updater runtime validated at c1455479b without merging that experimental branch history.

Included: signed local-only packaging, version/header UI, private approved update IPC, native Squirrel replacement, exact registered daemon ownership, split durable shutdown/start handoff and registration CAS, truthful admission/quiescence and normal shutdown drainage.

Excluded: migration planners/apply/recovery commands, migration activation-mode writer lease, native replacement/rebuild helper, disposable app entrypoints and smoke harnesses. The passive fixed pending-marker startup refusal remains; this code does not create or resolve migration markers.

No approved private update manifest means no actionable update button. General registered daemon controls remain connection-only. The daemon must be explicitly started with PASEO_INSTALLED_UPDATE_CONTROL=1 for coordinated update admission.

This source integration does not migrate historical projects, change live homes, publish a build or restart the operating app. Existing signed c145 verification is evidence for its runtime; this reduced source selection still requires its own targeted validation.
