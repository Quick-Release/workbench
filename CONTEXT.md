# Workbench

An internal local dashboard that renders a host repo's planning and development work live and starts actions on it through the execution seam. Because it is an internal company tool, its two reporting flows have different consent postures and must never be conflated.

## Language

### Product

**Host repo**:
The repository workbench is installed in and renders. A workbench install serves exactly one host repo.
_Avoid_: target repo, project (ambiguous)

**Developer**:
An employee running workbench against a host repo. Telemetry identifies the Developer, not the install.
_Avoid_: user (ambiguous between Developer and marketing-blog reader)

**Control surface**:
The product posture: the dashboard renders the host repo's planning work live and starts actions on it, rather than mirroring a snapshot.
_Avoid_: read-only dashboard, mirror, report

**Execution seam**:
The single validated localhost API through which the browser reads live state and starts actions; behind it run only the tools a Developer would run by hand.
_Avoid_: write API (understates reads), backend (implies hosting)

**Planning state**:
What the dashboard may act on: issues, triage states, blocker edges, maps, decision tickets. Agent sessions are observed, not acted on, until session spawning is decided.
_Avoid_: project data (vague)

### Reporting

**Telemetry**:
Usage events (agent usage, outcomes, health) collected from every Developer without an opt-out and reported to the company. Numbers about activity, never content.
_Avoid_: analytics (too vague), tracking (implies stealth)

**Content sourcing**:
The flow where a Developer explicitly submits a commit message, with attribution, for use in marketing blog posts. Separate from Telemetry: content never leaves the machine without the Developer's explicit submission.
_Avoid_: commit mining, scraping (both imply Telemetry-style automatic collection)

**Submission**:
A Developer's explicit act of sending one commit message into Content sourcing. The boundary event that makes content collection consensual.
_Avoid_: upload, share

**Highlights**:
The dashboard page where commit-message candidates surface for a Developer to review and submit. Nothing on it leaves the machine until a Submission is made.
_Avoid_: feed, showcase

**Outcomes**:
The Telemetry group measuring a Developer's merged work on a host repo — pull-request counts and merge timing.
_Avoid_: productivity metrics (evaluative connotation)

**Session capture**:
The content-bearing record of a Developer's own agent traffic — prompts, completions, and per-request metadata — collected only after the Developer points their agent at the capture proxy. Distinct from Telemetry: capture carries content, and exists only behind an explicit opt-in configuration.
_Avoid_: LLM logging, traffic recording (both imply automatic collection), Telemetry (the two postures must never be conflated)

### Skills and workflow

Language for the skills ecosystem the dashboard renders, resolved from the Ask Matt skill map.

**Catalog**:
Every skill the skills ecosystem defines, whether or not the host repo has it installed. The flow graph always renders the full Catalog; uninstalled entries render dimmed with a way to install.
_Avoid_: skill list (ambiguous), registry (implies a hosted service)

**Installed**:
A skill present in the host repo, via the skills CLI lockfile or a well-known skill directory. A property of the host repo, never of the Catalog.
_Avoid_: downloaded, available, active

**Skill flow**:
A path through the agent skills. The ecosystem has one main flow, on-ramps that merge onto it, standalone skills, and vocabulary layers running underneath.
_Avoid_: pipeline (implies a single linear track)

**Main flow**:
The route most work travels: grill (grill-with-docs) → optional prototype detour (bridged by handoff both ways) → spec (to-spec) → tickets (to-tickets) → implement (driving TDD, closing with code review). One unbroken context window through tickets; each implement starts fresh.
_Avoid_: pipeline, lifecycle

**On-ramp**:
A starting situation that generates work and then merges onto the main flow: triage, diagnosing-bugs, wayfinder.
_Avoid_: entry point (too generic)

**Flow role**:
Where a skill sits on the skill flow: main-flow step, on-ramp, standalone, vocabulary layer, or primitive. A skill the map doesn't place has no flow role. Distinct from skill category.
_Avoid_: type, kind (overloaded)

**Skill category**:
The ecosystem's own grouping of a skill — engineering, productivity, plus upstream holding pens (in-progress, misc). Coarser than flow role; a skill has both.
_Avoid_: type

**Skill flow edge**:
A declared relationship between two skills: merges-onto, delegates-to, pairs-with, runs-internally, hands-off-to, or next-step.
_Avoid_: link (overloaded with tracker links), dependency (that's blocker edge)

**Primitive**:
A skill that runs inside other skills rather than being reached for directly — grilling runs under both grill-me and grill-with-docs. Direct use is permitted but rare.
_Avoid_: helper, utility

**Workflow phase**:
Where a work item sits on a skill flow — grilling, prototyping, specced, ticketed, implementing, reviewing, shipped. A work item has no phase until a flow skill first touches it. Distinct from triage state: an issue can be ready-for-agent while its effort sits in the spec phase.
_Avoid_: status (overloaded with triage state and ticket status)

**Triage state**:
The five tracker roles (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix) plus unlabeled, moved by the triage skill. Distinct from workflow phase.
_Avoid_: label (the label string is the encoding, not the concept)

**Deferred**:
A parked work item: not being worked now, not refused. Orthogonal to both triage state and workflow phase.
_Avoid_: wontfix (that's refusal), backlog (that's an unordered pile)

**Blocker edge**:
A declared dependency from a ticket to the tickets that must close before it can start — native links on the tracker, "Blocked by" lines in local ticket files. Endpoints may live in different sources: any ticket can gate any other.
_Avoid_: dependency string (the lossy display encoding it replaces), sub-issue (that's map membership)

**Frontier**:
The open, unblocked, unclaimed work at the edge of an effort: implementation tickets whose blockers are all closed, and map decision tickets with no open blockers. What "pick next" means everywhere in Workbench.
_Avoid_: backlog (unordered), queue (implies FIFO)

**Map**:
A wayfinder issue (labelled wayfinder:map) charting a foggy effort as decision tickets; the index of decisions so far, not-yet-specified fog, and out-of-scope work for that effort.
_Avoid_: epic (a map holds decisions, not features)

**Decision ticket**:
A child issue of a map whose resolution is a decision, not a build slice; typed research, prototype, grilling, or task.
_Avoid_: task (overloaded with implementation work)

**Map membership**:
A decision ticket's belonging to a map, recorded as a tracker sub-issue; the membership order is the order the map's frontier is worked in. Membership groups tickets onto a map; blocker edges sequence them.
_Avoid_: parent-child (ambiguous with session trees), sub-issue (the tracker encoding, not the concept)

### Decisions and artifacts

**Decision**:
A conclusion the planning work reached, sourced from exactly one of: an ADR file, a decision ticket's Resolution, or a spec's implementation-decisions section as one bundle per spec. The same conclusion may exist as both a Resolution and an ADR — two records over one work item, grouped by it, never merged.
_Avoid_: decision ticket (the tracker issue a Resolution closes), ADR (one source form, not the concept)

**Resolution**:
The answer posted as the closing comment on a decision ticket; the durable content of that ticket's decision. The map's one-line decisions-so-far gist points at it and is never a second copy.
_Avoid_: verdict (prototype language), gist (the map's index line)

**Artifact**:
A file a skill session left at a findable repo location — the supporting evidence, not the Decision it produced. Research notes are the modeled kind; handoff docs, questionnaires, wizard scripts, and prototype branches are deliberately not modeled.
_Avoid_: output (any byproduct, modeled or not), deliverable (implies a shipped product)
