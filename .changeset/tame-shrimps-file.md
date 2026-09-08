---
"@quick-release/workbench": patch
---

Fixed the Highlights Submit action: the submission client now pins the wire body to the seam's contract fields, so a Submission no longer fails the seam's excess-property validation when the page's candidate carries its display date — every real Submit was being rejected as `malformed_request`. The seam schema rejects excess properties by design; the client, not the caller, owns the payload. Also adds the interactive Submit coverage ticket #18 asked for: a happy-dom component test that clicks a rendered Submit button and asserts the network boundary receives exactly the contract payload, plus a client-level unit pin.
