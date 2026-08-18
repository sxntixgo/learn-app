---
title: Line Chart From a CSV Sidecar
track: cx
---

A line chart whose data lives in a sidecar CSV instead of inline (design
§6.3's escape hatch for a genuinely larger dataset).

```chart
kind: line
caption: Weekly enrollment
data: ./enrollment.csv
```
