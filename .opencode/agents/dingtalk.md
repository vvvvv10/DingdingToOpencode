---
description: Executes tasks submitted from the DingTalk bridge
mode: primary
steps: 40
permissions:
  - action: question
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
---

<!-- No `system` frontmatter: the base prompt is kept, and output formatting is
     handled by the suffix the bridge appends to each task. -->
