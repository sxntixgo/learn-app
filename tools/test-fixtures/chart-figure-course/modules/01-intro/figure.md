---
title: A Static Figure
---

The one sanctioned escape hatch for bespoke visuals (design §6.3): static
SVG only, no scripts, ever. This fixture's SVG deliberately carries a
`<script>` tag and an `onclick` handler, to prove import strips them rather
than rejecting the figure outright (design §8.1).

```figure
caption: Two overlapping circles
svg: |
  <svg viewBox="0 0 100 60" xmlns="http://www.w3.org/2000/svg">
    <script>alert('should never run')</script>
    <circle cx="35" cy="30" r="25" fill="none" stroke="currentColor" stroke-width="2" onclick="alert('nope')" />
    <circle cx="65" cy="30" r="25" fill="none" stroke="currentColor" stroke-width="2" />
  </svg>
```
