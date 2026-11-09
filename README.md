# dev-footer

A personal visual layer for [Pi](https://pi.dev): a compact HUD footer, a subagent list, and transcript renderers for [dev](https://github.com/taekwondodev/dev)'s background work.

The HUD works in plain Pi. The subagent list and work renderers need dev's structured events and result details. This extension changes presentation, not execution or model context. When [dev-hush](https://github.com/taekwondodev/dev-hush) is active, its transcript filtering still applies.

## Install

Clone directly into Pi's global extension directory:

```sh
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/taekwondodev/dev-footer.git ~/.pi/agent/extensions/dev-footer
```

Restart Pi. It discovers the directory's `index.ts` automatically. No npm publication, package-gallery registration, `pi install`, or `--extension` flag is needed. If `PI_CODING_AGENT_DIR` is set, use its `extensions/dev-footer` directory instead. Do not keep a second copy enabled elsewhere.

This checkout may already be installed on the maintainer's machine. Do not clone over an existing directory.

## Use

- `/footer` toggles between the HUD and Pi's default footer.
- The HUD shows repository, model, context, cost and cache information.
- With dev, background children appear below the editor and their work outcomes get compact transcript rows.

The visual design targets Ghostty with JetBrainsMono Nerd Font Mono and Ghostty's icon codepoint mapping to JetBrainsMono Nerd Font. Other terminals or fonts may show missing glyphs; no fallback is provided. Colors follow Pi's active theme. The maintainer uses rose-pine-moon.

Git supplies repository facts. The optional pull-request lookup uses an installed, authenticated `gh` CLI. The extension reads repository/session data and can query GitHub for pull-request metadata; it does not write project files.

## Update

```sh
git -C ~/.pi/agent/extensions/dev-footer pull --ff-only
```

Then restart Pi or use `/reload`. Pi supplies the runtime modules; no `npm install` is needed.

## Verification

Checked against Pi 1.5.0. The existing check targets Pi's official installer layout and an installed checkout at `<agent-dir>/extensions/dev-footer`. It also requires the maintainer's `themes/rose-pine-moon.json` in that agent directory; the theme is not bundled here.

```sh
cd ~/.pi/agent/extensions/dev-footer
node check.mjs
```

The fixtures come from scripted, disposable dev runs, not personal conversations. See [EXPECTED-BEHAVIOR.md](EXPECTED-BEHAVIOR.md) for the detailed visual contract.
