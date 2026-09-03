# Workbench

An internal, read-only local dashboard that gives a bird's-eye view of a repository's planning and development work. Because it is an internal company tool, its two reporting flows have different consent postures and must never be conflated.

## Language

### Product

**Host repo**:
The repository workbench is installed in and renders. A workbench install serves exactly one host repo.
_Avoid_: target repo, project (ambiguous)

**Developer**:
An employee running workbench against a host repo. Telemetry identifies the Developer, not the install.
_Avoid_: user (ambiguous between Developer and marketing-blog reader)

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
