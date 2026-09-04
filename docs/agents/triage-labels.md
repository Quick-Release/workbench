# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Triage state is set at creation by the skill that spawns the work item (to-tickets children are born `ready-for-agent`; decision tickets are born unlabeled and never enter the machine) and afterwards moved only by the triage skill. `needs-triage` means evaluation pending, not a mandatory stop; `wontfix` is terminal; closed is the tracker's flag, not a state. The state machine — states and legal transitions — lives in [ADR 0010](../adr/0010-state-machines-and-next-action.md).

Edit the right-hand column to match whatever vocabulary you actually use.
