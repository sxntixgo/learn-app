---
title: Quiz One
kind: quiz
---

A quiz whose second question has no correct choice — unpassable, and must
fail import rather than being stored silently.

```quiz
pass: 0.7
questions:
  - prompt: Which is a deep module?
    choices:
      - text: A class with one method and a large interface
      - text: A class with a simple interface hiding real complexity
        correct: true
  - prompt: This question has no correct answer at all
    choices:
      - text: Option A
      - text: Option B
```
