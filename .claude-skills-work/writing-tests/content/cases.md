# api/src/content/** — test cases

Goal: statement coverage 93.1% -> >=97%. The units below are the trust
boundary between this app and a git repo someone else controls, so every case
listed is a REFUSAL or an ERROR path unless marked otherwise.

Legend: [x] written & mutation-checked, [-] dropped (unreachable / no value)

---

## Unit: `present.ts` — presentBlocks / hashSnapshot / codeLineCount
Contract: strips `correct` from every quiz choice; anything it does not
recognise comes back UNCHANGED rather than throwing (a stripping bug must
never become a 500 on every lesson page). No file tested this before.
New file: `present.test.ts`.

- [x] happy: a quiz block loses `correct`, keeps text/prompt/track/pass
- [x] happy: a non-quiz block passes through byte-identical
- [x] boundary: an empty blocks array
- [x] edge: `blocks` is not an array (null/undefined/object/string)
- [x] edge: null or primitive entries inside the array
- [x] edge: quiz whose `questions` is not an array
- [x] edge: a question that is not an object
- [x] edge: a question whose `choices` is not an array
- [x] edge: a choice that is not an object (null / string)
- [x] security: the ORIGINAL block is not mutated — routes/quiz.ts still needs `correct`
- [x] hashSnapshot: stable, one-char change differs, key ORDER matters, 64-hex
- [x] codeLineCount: 1 line; trailing "\n"; "\n\n"; ""; a lone "\n"

## Unit: `validate-dir.ts` — validateCourseDir
Contract: collect EVERY problem instead of throwing on the first, and keep the
manifest's slug so a FAILED import_runs row can still name the course.
New file: `validate-dir.test.ts`.

- [x] happy: two modules / three lessons -> ok + summary counts
- [x] error: no course.yaml -> one problem naming the dir, NO slug
- [x] error: schema failures -> one problem per line, each `course.yaml:`-prefixed, NO slug
- [x] error: a refused traversal path -> names the entry AND the module, does NOT
      echo the absolute path, and the run CONTINUES to the next lesson
- [x] error: a missing lesson file
- [x] error: a lesson path that is a directory (EISDIR) -> collected, not thrown
- [x] error: a lesson with no title -> parse problem prefixed by srcPath
- [x] error: a missing chart CSV sidecar
- [x] error: block-schema errors -> every error with its JSON Pointer, and the
      NEXT lesson is still validated; slug survives, summary absent
- [-] boundary: a module with zero lessons — course.schema.json sets minItems: 1

## Unit: `manifest.ts` — the containment chokepoint
- [x] loadCourseManifest: unparseable YAML is a YAML error, not schema noise
- [x] resolveLessonPath: `.`, `./`, `./.` resolve to the course root and are REFUSED
- [x] resolveLessonPath: an intermediate segment that is a regular FILE (ENOTDIR)
- [x] resolveChartSidecars: sidecar exists but cannot be read (it is a directory)
- [-] the 4th check (containment on the fully resolved real path) — genuinely
      unreachable while checks 2 and 3 hold; documented as such in the source

## Unit: `csv.ts`
- [x] a data row with FEWER cells than the header, in both column orders

## Unit: `validate.ts` — validateBadgeCriteria (the closed vocabulary)
- [x] happy: a known type validates against its OWN branch
- [x] error: not an object — including an ARRAY (`typeof [] === 'object'`)
- [x] error: `type` missing / number / null / array
- [x] error: an unknown type -> ONE error listing all eight
- [x] error: a known type with a misspelled field -> 2 errors about THAT type,
      no `oneOf` noise
- [x] error: a known type missing its own required field
- [x] BADGE_CRITERION_TYPES is read off the schema and has eight entries

## Unit: `import.ts` — refusals before any write, and in-place updates
- [x] error: the same module id declared twice
- [x] error: two lessons deriving the same slug (README.md + index.md) -> both files named
- [x] error: blocks that fail the schema -> "refusing to write" + JSON Pointer
- [x] error: a badge whose criteria are outside the closed vocabulary
- [x] update: a re-styled track is UPDATED in place, keeping its id
- [x] update: a retitled/re-scoped degree is UPDATED in place, keeping its id
- [x] boundary: a module with no lessons at all (hand-built LoadedCourse)

## Unit: `run-import.ts` — the "never throws" contract
- [x] error: the connection itself is unusable -> stage 'failed' with no run id,
      never an exception, and the temp clone is still removed (design §4)
- [-] the 'parsing'-stage failure branch: validateCourseDir and loadCourse run the
      IDENTICAL per-lesson checks, so reaching it needs the clone directory to
      change between the two — no in-process seam short of faking a race
