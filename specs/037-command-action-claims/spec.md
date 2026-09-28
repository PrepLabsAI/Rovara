# Truthful command-only action replies (#104)

An ordinary model turn must never report that it closed a workspace or changed the coding model.
Neither action is an orchestrator tool. The model must direct workspace-close requests (including
“Close the workspace” and variants) to the exact `close this workspace` command. For coding-model
selection it must explain `models` and `use <model>` without inventing approved/current models.
The same rule applies to actions available only through commands or buttons.

Do not change command recognition, grant new tools, or bypass the unpublished-work check. That
matching issue is tracked separately. Add eval cases requiring no tools and correct instructions,
with negative scoring for false success claims even when the command also appears in the reply.
Offline eval verifies wiring/scoring only; it is not live-model behavioral evidence.
