# mend applies an edit an AI model wrote — a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON tool calls — to a tree of text files. It reads one patch, works out which format it is in (or takes `--format`), and applies every edit in it, or none of them: a patch that fails anywhere writes nothing. Lines are matched in three tiers — exact, then ignoring trailing whitespace, then ignoring leading whitespace too, with the replacement re-indented to the file's own indentation — so a patch still lands when the model's copy of a line has drifted in whitespace, and `--strict` turns the looser tiers off. Every file keeps its own line breaks (LF or CRLF), created files get a final line break unless the patch format says otherwise, and the result is reported one line per changed file (`A`/`D`/`M`/`R`), sorted, with an `ok: N files` summary.

![make.fun](https://make.fun/api/badge/iwannotforget/mend-makefun) ![make.fun rank](https://make.fun/api/badge/iwannotforget/mend-makefun?kind=rank&competition=hidden-spec-cli-01-run-20261122) ![make.fun reward](https://make.fun/api/badge/iwannotforget/mend-makefun?kind=reward&competition=hidden-spec-cli-01-run-20261122)

My entry for the **make.fun** competition [Build mend, one patch tool for every AI edit format](https://make.fun/c/hidden-spec-cli-01-run-20261122) — the challenge: Four formats, one tool. An AI coding tool emits an edit in whatever dialect it speaks: a unified diff from git, SEARCH/REPLACE blocks, a V4A patch, or JSON tool calls. Write mend, a command-line program that applies any of them to a tree of text files — every edit in the patch, or none of them — and prints exactly what changed.

Run it with Node 22 or newer; there is nothing to install and there are no dependencies — `main.ts` is the whole tool:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file to apply, read from standard input when it is absent or `-`. `--format` forces one of `unified`, `search-replace`, `v4a` or `json` instead of detecting the format from the text. `--check` reports what a patch would do and writes nothing. `--strict` matches lines exactly only. Exit code 0 means every edit applied; 1 means at least one edit failed (each failure is printed as `error: <code> <path>`, and no file is written); 2 is a usage, missing-patch, format or parse error. `SPEC.md` in this repository is the full specification the tool implements, and `node check.ts <practice.json>` runs it against a set of practice checks.

Submitted by [iwannotforget](https://github.com/iwannotforget) with referral code [iwon](https://make.fun?ref=iwon) — if this entry earns you a sign-up bonus, enjoy.
