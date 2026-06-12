---
name: upgrade
description: Bring this project's runtime and dependencies current — Node LTS, Bun, npm deps, Docker base images, GitHub Actions — applying soaking discipline (don't adopt brand-new or pre-release versions), upgrading in tiers, and verifying after each. Use when asked to update dependencies, bump versions, "get current", or audit what's outdated.
---

# Upgrade

Keep the stack current **without** chasing bleeding edge. The goal is "latest *soaked* stable," not "latest published."

## Soaking policy (the guardrails)

1. **Let releases soak.** Don't adopt a version that's too fresh — regressions surface in the first couple of weeks.
   - patch/minor: prefer ≥ ~2 weeks old.
   - major: prefer ≥ ~4 weeks old, and read the changelog first.
   - If the only available version of a needed fix is fresh, take it but say so.
2. **Runtimes track the current *Active LTS*, never "Current"/odd lines.** Node: the even LTS in maintenance/active phase (today that's **Node 24**). Never an odd/Current Node in the image or `.mise.toml`.
3. **Never adopt pre-release / alpha / beta / next-tag.** Check `npm view <pkg> dist-tags`. If `latest` ≠ the newest version, the newest is a pre-release — ignore it.
4. **One major per commit.** Patch/minor bumps batch together; each major gets its own commit so a bad one is easy to revert and bisect.
5. **Verify after every batch** (see Verification). A bump isn't done until tsc + tests + CSS build + a smoke boot all pass.
6. **Respect the hold list.** Some deps are deliberately pinned below latest; don't bump them without re-checking the reason.

## Where versions are pinned (keep these in sync)

- **npm deps:** `package.json` carets are the *allowed range*; the committed `bun.lock` is the exact pin. `--frozen-lockfile` in both the Dockerfile and CI enforces it. After bumping a floor, run `bun install` and commit the updated `bun.lock`.
- **Toolchain:** `.mise.toml` pins Bun and Node to **exact** versions (not majors). CI's `setup-bun` `bun-version` must match the `.mise.toml` bun pin.
- **Docker base images:** pinned to exact patch tags (`node:<x.y.z>`, `node:<x.y.z>-slim`, `oven/bun:<x.y.z>` — both the build `FROM` and the `COPY --from`). Optional hardening: pin by `@sha256:` digest.

When you bump any of these, update *all* of its locations in the same commit.

## Project hold list (re-evaluate, don't blindly bump)

- **`@modelcontextprotocol/sdk` → stay on `1.x`.** v2 is pre-alpha (no stable release; restricted PRs). Build on 1.x until v2 ships stable and has soaked.
- **`zod` → stay on `3.25.x`.** The MCP SDK and `@hono/mcp` are built against Zod 3.25 (`zod/v4` internal compat). Jumping our direct dep to Zod 4 risks type/peer drift across the tool schemas. Revisit once the MCP SDK's published peer range includes Zod 4.

When a hold is lifted, update this list in the same commit.

## Procedure

1. **Inventory.** Read `package.json`, `.mise.toml`, `Dockerfile` (all `FROM`), and `.github/workflows/*`.
2. **Find latest + release dates.**
   - `bun outdated` for npm deps.
   - For anything you intend to move: `npm view <pkg> version dist-tags time` — confirm `latest` is the newest (not a pre-release) and check the release date against the soaking thresholds.
   - Node: confirm the target is the current Active LTS (nodejs.org/en/about/previous-releases) and that engines (e.g. obsidian-headless needs Node ≥ 22) still hold.
   - Docker base images: check the tag exists (`node:<lts>-slim`, `oven/bun:1`).
   - Actions: check each `uses:` major against its repo's latest release.
3. **Classify** each candidate: patch / minor / major, and soaked / too-fresh / pre-release / held.
4. **Apply in tiers, committing per tier:**
   - **Tier 1 — runtime:** Node LTS in `.mise.toml`, every Dockerfile `FROM`, and any workflow `node-version`. Bun stays on its major (`oven/bun:1`).
   - **Tier 2 — minor/patch deps:** bump floors in `package.json`, `bun update`, verify.
   - **Tier 3 — majors, one per commit:** read changelog, bump, fix breakage, verify.
   - **Tier 4 — CI/images:** Action majors and base-image tags.
5. **Record holds and skips.** Anything left behind gets a one-line reason in the commit body and (if durable) the hold list above.

## Verification (run after each tier — all must pass)

```sh
bun install
bunx tsc --noEmit
bun test
bunx @tailwindcss/cli -i styles/app.css -o public/app.css   # CSS still compiles
PUBLIC_URL= bun src/server.ts   # smoke boot: migrations apply, listens, then Ctrl-C
```

If a bump fails verification and the fix isn't quick, revert that bump, leave it on the hold list with the reason, and move on. Don't leave the tree red.

## Commit style

One commit per tier (and per major). Message names what moved and what was deliberately held, e.g.:

```
Upgrade to Node 24 LTS

Active LTS, soaked since Oct 2025. obsidian-headless still satisfied (≥22).
Updated .mise.toml, both Dockerfile stages, ob install stage.
```
