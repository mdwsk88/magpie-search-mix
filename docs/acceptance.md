# Acceptance checks

A change is ready for the owner's review only when it shows the checks below.
Write `Not run: <check> (why)` for a check you did not run. Never leave one out.

1. **Red, then green.** Put the old code back: the new test fails on the behaviour it is about. A compile error or a skipped test does not count. With the change, it passes. Name the test and quote the failure.
2. **Broken on purpose.** Break the logic the change protects in one or two ways. A test must fail each time.
3. **The whole suite.** `bun test` passes: the whole suite, not only the files you touched. Quote its last lines.
4. **No network, no real keys.** Tests use stubs and `test/fixtures/`. A real key never goes into the repository, a test, a log or a reply.
5. **Real use.** A change to how a search API is asked or read is tried against the real API by the owner before merging, since the merge publishes it: with `bun scripts/try.js`, or in magpie. An agent has no keys, so it writes `Not run: real API (needs the owner's key)`.
6. **Both READMEs.** When what a user sees or writes changes, `README.md` and `README.zh-CN.md` both say so.
7. **One request, every sibling.** One request per pull request. A place with the same problem is fixed in the same change, or listed as not fixed.
8. **A new version.** A change to what npm ships raises the version in `package.json` and `VERSION` in `src/vendors.js`: the patch number for a fix, the minor number for a new option or behaviour. Say which version the merge publishes.

The owner merges. A merge to `main` that carries a new version is published to npm by `release.yml`, which also tags it.
A rule seen in [LESSONS.md](../LESSONS.md) on 3 separate days is added here.
