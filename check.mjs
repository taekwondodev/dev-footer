import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, copyFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";

const agentDir = fileURLToPath(new URL("../../", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const release = readFileSync(join(agentDir, "install/current-version"), "utf8").trim();
const modules = join(agentDir, "install/releases", release, "node_modules");
const { createJiti } = await import(join(modules, "jiti/lib/jiti.mjs"));
const piIndex = join(modules, "@earendil-works/pi-coding-agent/dist/index.js");
const tuiIndex = join(modules, "@earendil-works/pi-tui/dist/index.js");
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-coding-agent": piIndex, "@earendil-works/pi-tui": tuiIndex },
});

// Count every file the extension opens, to prove render() reads memory only.
let opens = 0;
const open = fsPromises.open;
fsPromises.open = (...args) => {
  opens++;
  return open(...args);
};
syncBuiltinESMExports();

const [pi, themes, tui, hud, list, rows, session, stats, repo, view, header] = await Promise.all([
  import(piIndex),
  import(join(modules, "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")),
  import(tuiIndex),
  jiti.import("./lib/hud.ts"),
  jiti.import("./lib/list.ts"),
  jiti.import("./lib/rows.ts"),
  jiti.import("./lib/session.ts"),
  jiti.import("./lib/stats.ts"),
  jiti.import("./lib/repo.ts"),
  jiti.import("./lib/view.ts"),
  jiti.import("./lib/header.ts"),
]);
const { KeybindingsManager } = await import(join(modules, "@earendil-works/pi-coding-agent/dist/core/keybindings.js"));
tui.setKeybindings(new KeybindingsManager());
const theme = themes.loadThemeFromPath(join(agentDir, "themes/rose-pine-moon.json"), "truecolor");
themes.setThemeInstance(theme);
const plain = (line) => tui.stripTerminalSequences(line);
const width = (line) => tui.visibleWidth(line);
const text = (lines) => lines.map(plain).join("\n");

// Real payloads: views built by dev's view builder from the replay of two real children,
// and a lead's work results, outcome messages and child session files from dev's own run.
const fixtures = join(here, "fixtures");
const views = JSON.parse(readFileSync(join(fixtures, "views.json"), "utf8"));
const transcript = JSON.parse(readFileSync(join(fixtures, "transcript.json"), "utf8"));
const scene = (name) => views[name].view;
const sceneAt = (name) => views[name].at;
const resultFor = (taskId) => transcript.results.find((result) => result.input.taskId === taskId);
const outcomeFor = (taskId) => transcript.outcomes.find((message) => message.details.outcomes[0].taskId === taskId);
const scratch = mkdtempSync(join(tmpdir(), "dev-footer-"));
const withSession = (message, file) => ({
  ...message,
  details: { ...message.details, children: message.details.children.map((child) => ({ ...child, sessionFile: file })) },
});

let failures = 0;
const claim = async (name, body) => {
  try {
    await body();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.log(`not ok - ${name}\n${error.stack}`);
  }
};
const settle = async (predicate) => {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise((done) => setTimeout(done, 10));
};

// A fake Pi with a real event bus, recording what the extension installs.
const installExtension = async (options = {}) => {
  const { default: install } = await jiti.import("./index.ts");
  const events = pi.createEventBus();
  const handlers = new Map();
  const widgets = [];
  const toolRenderers = [];
  const messageRenderers = new Map();
  let footer;
  let renders = 0;
  let sessionId = options.sessionId ?? transcript.views[0]?.sessionId ?? "session";
  const fakeTui = { requestRender: () => renders++ };
  const ctx = {
    mode: "tui",
    ui: {
      theme,
      setFooter: (factory) => {
        footer = factory?.(fakeTui, theme, {
          onBranchChange: () => () => {},
          getGitBranch: () => options.branch?.() ?? null,
          getExtensionStatuses: () => new Map([["dev/work", "1 running │ arena opus 12%"]]),
        });
      },
      setWidget: (key, factory, widgetOptions) => {
        widgets.push({ key, options: widgetOptions, component: factory?.(fakeTui, theme) });
      },
      notify() {},
    },
    sessionManager: {
      getCwd: () => options.cwd ?? tmpdir(),
      getSessionId: () => sessionId,
      getLeafId: () => null,
      getEntries: () => [],
      getBranch: () => [],
      getSessionName: () => undefined,
    },
    getContextUsage: () => undefined,
  };
  install({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand() {},
    registerToolRenderer: (resolver) => toolRenderers.push(resolver),
    registerMessageRenderer: (type, renderer) => messageRenderers.set(type, renderer),
    getThinkingLevel: () => "high",
    events,
  });
  return {
    events,
    handlers,
    widgets,
    toolRenderers,
    messageRenderers,
    ctx,
    get footer() {
      return footer;
    },
    get renders() {
      return renders;
    },
    widget: () => widgets.at(-1)?.component,
    start: (id) => {
      if (id !== undefined) sessionId = id;
      handlers.get("session_start")({}, ctx);
    },
    stop: () => {
      handlers.get("session_shutdown")?.();
      footer?.dispose?.();
      for (const { component } of widgets) component?.dispose?.();
    },
  };
};

const realSession = transcript.views[0]?.sessionId;
const at = (name, columns) => list.listRows(theme, scene(name), columns, sceneAt(name));

await claim("the list is a below-editor widget set on every session_start that renders nothing without children", async () => {
  const pi = await installExtension({ sessionId: realSession });
  try {
    pi.start();
    pi.start();
    assert.equal(pi.widgets.length, 2, "re-set on session_start");
    for (const { key, options } of pi.widgets) {
      assert.equal(key, "dev-footer/subagents");
      assert.equal(options?.placement, "belowEditor");
    }
    assert.deepEqual(pi.widget().render(120), []);
    pi.events.emit("dev/work-view", { sessionId: realSession, children: [], commands: { running: 0 }, blocks: { agentsBlocked: false, reactivationSuspended: false } });
    assert.deepEqual(pi.widget().render(120), []);
    assert.deepEqual(list.listRows(theme, undefined, 120, 0), []);
  } finally {
    pi.stop();
  }
});

await claim("views of other sessions and malformed payloads are ignored", async () => {
  const pi = await installExtension({ sessionId: scene("running").sessionId });
  try {
    pi.start();
    pi.events.emit("dev/work-view", { ...scene("running"), sessionId: "another-session" });
    assert.deepEqual(pi.widget().render(120), []);
    for (const malformed of [
      null,
      "view",
      { ...scene("running"), children: [{ id: 1 }] },
      { ...scene("running"), commands: {} },
      { ...scene("running"), children: [{ ...scene("running").children[0], status: "exploded" }] },
      { ...scene("running"), children: [{ ...scene("running").children[0], activity: { kind: "dancing" } }] },
    ])
      pi.events.emit("dev/work-view", malformed);
    assert.deepEqual(pi.widget().render(120), []);
    pi.events.emit("dev/work-view", scene("running"));
    assert.equal(pi.widget().render(120).length, 2);
  } finally {
    pi.stop();
  }
});

await claim("no list row is wider than the terminal from 20 to 220 columns in any real view", () => {
  for (const name of Object.keys(views))
    for (let columns = 20; columns <= 220; columns++)
      for (const row of at(name, columns)) assert.ok(width(row) <= columns, `${name} at ${columns}: ${width(row)}: ${plain(row)}`);
});

await claim("a running child shows glyph, title, task and activity, with model, turns, context and duration on the right", () => {
  const [first, second] = at("running", 120).map(plain);
  assert.match(first, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]  architect {2}281 arena snapshot {3,}read src\/work-controller\.ts/u, first);
  assert.match(first, /sonnet-5-5 · ↻ 3 · \d+% · \dm \d\ds$/u, first);
  assert.match(second, /writing…/u, second);
  const columns = (row) => [row.indexOf("281"), row.search(/read |writing/u)];
  assert.deepEqual(columns(first), columns(second), "title, task and activity align in columns");
});

await claim("at 80 columns model and context drop, turns and duration stay, and the task is cut before the activity", () => {
  for (const row of at("running", 80).map(plain)) {
    assert.ok(!row.includes("sonnet") && !row.includes("%"), row);
    assert.match(row, /↻ \d+ · \dm \d\ds$/u, row);
  }
  const long = { ...scene("running"), children: [{ ...scene("running").children[0], taskId: "a-very-long-task-key-that-cannot-fit-beside-its-activity-at-eighty-columns" }] };
  const [row] = list.listRows(theme, long, 80, sceneAt("running")).map(plain);
  assert.ok(row.includes("read src/work-controller.ts"), row);
  assert.match(row, /a very long[^…]*…/u, row);
});

await claim("rows are ordered running, waiting, failed, cancelled, completed, at most five, then +N counts the rest by status", () => {
  const base = scene("one-finished").children;
  const make = (status, index) => ({ ...base[0], id: `id-${index}`, taskId: `task-${index}`, status, startedAt: index, ...(status === "running" || status === "waiting" ? { completedAt: undefined } : { completedAt: 100 }) });
  const mixed = ["completed", "cancelled", "running", "failed", "waiting", "completed", "running"].map(make);
  const lines = list.listRows(theme, { ...scene("one-finished"), children: mixed }, 120, 200).map(plain);
  assert.deepEqual(lines.slice(0, 5).map((row) => row[0]), ["⠙", "⠙", "◌", "✗", "⊘"].map((mark) => (mark === "⠙" ? lines[0][0] : mark)));
  assert.equal(lines[5], "+2  2 completed");
  const many = at("many", 120).map(plain);
  assert.equal(many.length, 6);
  assert.match(many[5], /^\+4 {2}\d+ (running|completed)/u, many[5]);
  assert.ok(many.slice(0, 5).every((row, index, all) => index === 0 || header.STATUS_ORDER[statusOfMark(all[index - 1])] <= header.STATUS_ORDER[statusOfMark(row)]), many.join("\n"));
});
await claim("settled rows put the latest first, and a group with a running leaf outranks finished rows", () => {
  const base = scene("one-finished").children[0];
  const done = (index, completedAt) => ({ ...base, id: `done-${index}`, taskId: `done-${index}`, status: "completed", startedAt: index, completedAt });
  const rows = list.listRows(theme, { ...scene("one-finished"), children: [done(1, 10), done(2, 30), done(3, 20)] }, 120, 100).map(plain);
  assert.deepEqual(rows.map((row) => row.match(/done \d/u)?.[0]), ["done 2", "done 3", "done 1"]);
  const coordinator = { ...done(4, 5), id: "coord", taskId: "coord", coordinator: true };
  const leaf = { ...base, id: "leaf", taskId: "leaf", parent: "coord", status: "running", startedAt: 4, completedAt: undefined };
  const grouped = list.listRows(theme, { ...scene("one-finished"), children: [done(2, 30), coordinator, leaf] }, 120, 100).map(plain);
  assert.deepEqual(grouped.map((row) => row.match(/done \d|coord|leaf/u)?.[0]), ["coord", "leaf", "done 2"]);
});
function statusOfMark(row) {
  return { "✓": "completed", "✗": "failed", "⊘": "cancelled", "◌": "waiting", "?": "unknown" }[row[0]] ?? "running";
}

await claim("leaves are indented under their coordinator with └", () => {
  const [coordinator, leaf] = at("coordinator", 120).map(plain);
  assert.match(coordinator, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]  architect/u, coordinator);
  assert.match(leaf, /^ {3}└ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]  architect/u, leaf);
});

await claim("context is colored only while the child runs, from 60% warning and from 85% error", () => {
  const child = scene("running").children[0];
  const rowFor = (status, percent) =>
    list.listRows(theme, { ...scene("running"), children: [{ ...child, status, ...(status === "running" ? {} : { completedAt: child.startedAt + 1000, activity: undefined }), context: { ...child.context, percent } }] }, 120, sceneAt("running"))[0];
  assert.ok(rowFor("running", 70).includes(theme.fg("warning", "70%")));
  assert.ok(rowFor("running", 90).includes(theme.fg("error", "90%")));
  assert.ok(rowFor("running", 30).includes(theme.fg("muted", "30%")));
  assert.ok(rowFor("completed", 90).includes(theme.fg("muted", "90%")));
});

await claim("a failed child shows its error, a completed child shows no activity", () => {
  const child = scene("finished").children[0];
  const [failed, done] = list.listRows(theme, { ...scene("finished"), children: [{ ...child, status: "failed", error: "provider overloaded" }, { ...child, id: "other" }] }, 120, sceneAt("finished"));
  assert.ok(failed.includes(theme.fg("error", "provider overloaded")), failed);
  assert.ok(plain(failed).startsWith("✗"));
  assert.match(plain(done), /^✓ {2}architect {2}281 arena snapshot {2,}sonnet/u, plain(done));
});

await claim("local commands are one dimmed line and each blocking notice gets its own warning row", () => {
  const lines = at("blocked", 120);
  const at0 = lines.findIndex((line) => plain(line) === "1 command running");
  assert.ok(at0 >= 0, "running commands are listed");
  assert.ok(lines.slice(0, at0).every((line) => !/^[✓✗⊘]/u.test(plain(line))), "only live rows precede the commands line");
  assert.deepEqual(lines.slice(-2).map(plain), [
    "!  subscription exhausted: new agents blocked",
    "!  lead failed: automatic reactivation suspended",
  ]);
  assert.equal(lines[at0], theme.fg("muted", "1 command running"));
  assert.ok(lines.at(-2).startsWith(theme.getFgAnsi("warning")));
  const commandsOnly = { ...scene("blocked"), children: [], commands: { running: 2 }, blocks: { agentsBlocked: false, reactivationSuspended: false } };
  assert.deepEqual(list.listRows(theme, commandsOnly, 80, 0).map(plain), ["2 commands running"]);
});

await claim("the spinner and durations redraw only while a child is active", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const pi = await installExtension({ sessionId: scene("running").sessionId });
  try {
    pi.start();
    pi.events.emit("dev/work-view", scene("running"));
    const before = pi.renders;
    mock.timers.tick(500);
    assert.ok(pi.renders - before >= 4, `${pi.renders - before} redraws`);
    pi.events.emit("dev/work-view", scene("finished"));
    const settled = pi.renders;
    mock.timers.tick(2000);
    assert.equal(pi.renders, settled);
  } finally {
    pi.stop();
    mock.timers.reset();
  }
});

const place = {
  folder: "dev", repoUrl: "https://github.com/taekwondodev/dev", branch: "feat/285-subagent-visibility", worktrees: 2,
  session: "subagent visibility", model: "claude-opus-5-5", thinking: "high",
  pullRequest: { number: 286, url: "https://github.com/taekwondodev/dev/pull/286", state: "open" },
  diff: { added: 120, removed: 30 },
};
const telemetry = {
  context: { percent: 28.4 }, cost: 0.534, cacheHit: 92.4,
  clock: { remainingMs: 192_000 }, runs: [12_000, 30_000, 45_000, 80_000, 120_000, 160_000, 140_000, 90_000],
};

await claim("the installed HUD begins with one blank row, then the two-row grid, and shows no extension status row", async () => {
  const pi = await installExtension();
  try {
    pi.start();
    for (const columns of [0, 1, 20, 80, 120, 200]) {
      const lines = pi.footer.render(columns);
      assert.equal(lines.length, 3, `${columns}: ${lines.length} rows`);
      assert.equal(lines[0], "");
      assert.ok(!text(lines).includes("running") && !text(lines).includes("─".repeat(10)), text(lines));
      for (const line of lines) assert.ok(width(line) <= Math.max(columns, 0) || columns < 2, `${columns}: ${plain(line)}`);
    }
  } finally {
    pi.stop();
  }
});

await claim("no HUD row is wider than the terminal from 20 to 220 columns", () => {
  for (let columns = 20; columns <= 220; columns++)
    for (const row of hud.hudRows(theme, place, telemetry, columns, true)) assert.ok(width(row) <= columns, `${columns}: ${width(row)}: ${plain(row)}`);
});

await claim("at 120 columns the grid shows place, session and worktrees left and model and telemetry right", () => {
  const [blank, top, bottom] = hud.hudRows(theme, place, telemetry, 120, false).map(plain);
  assert.equal(blank, "");
  for (const part of ["\u{f07b}  dev", "\u{f418}  feat/285-subagent-visibility", "\u{f407}  #286", "+120 −30"]) assert.ok(top.includes(part), top);
  assert.ok(top.endsWith("claude-opus-5-5  high"), top);
  for (const part of ["subagent visibility", "\u{f0645}  2"]) assert.ok(bottom.startsWith(part) || bottom.includes(part), bottom);
  assert.match(bottom, /\u{ee9c} {2}━━━─{7} 28% {3}\$0\.53 {3}92\.4% {3}\u{f0954} {2}3:12 {3}[⡀⣀⣄⣤⣦⣶⣷⣿]{8}$/u, bottom);
  assert.equal(width(hud.hudRows(theme, place, telemetry, 120, false)[1]), 120, "the right column is right-aligned");
  assert.ok(!top.includes("•") && !bottom.includes("•"), "groups are separated by spaces");
});

await claim("at 80 columns session, worktrees, pull request, cache hit and sparkline drop and the gauge shortens; folder, branch, diff, model, context and clock stay", () => {
  const [, top, bottom] = hud.hudRows(theme, { ...place, branch: "feat/monitor" }, telemetry, 80, false).map(plain);
  for (const part of ["dev", "feat/monitor", "+120 −30", "claude-opus-5-5"]) assert.ok(top.includes(part), top);
  assert.ok(!top.includes("#286"), top);
  assert.ok(!bottom.includes("subagent visibility") && !bottom.includes("\u{f0645}"), bottom);
  assert.ok(!bottom.includes("92.4%") && !/[⡀⣀⣄⣤⣦⣶⣷⣿]/u.test(bottom), bottom);
  assert.match(bottom, /\u{ee9c} {2}━━─{4} 28% {3}\$0\.53 {3}\u{f0954} {2}3:12$/u, bottom);
  const tight = hud.hudRows(theme, { ...place, branch: "feat/monitor" }, telemetry, 52, false).map(plain);
  for (const part of ["feat/monitor", "claude-opus-5-5", "28%", "3:12"]) assert.ok(tight.join("\n").includes(part), tight.join("\n"));
  assert.ok(!tight.join("").includes("…"), "the narrowest level fits before anything is cut");
});

await claim("beyond pine icons and the branch icon in accent, color marks state: pull request, diff, thinking level, context pressure and cache warmth", () => {
  const rest = { ...place, pullRequest: undefined, diff: undefined, thinking: undefined };
  const quiet = hud.hudRows(theme, rest, { ...telemetry, cost: 0, runs: [], clock: "cold" }, 120, false).join("");
  for (const color of ["success", "warning", "error"]) assert.ok(!quiet.includes(theme.getFgAnsi(color)), `${color} at rest`);
  assert.ok(quiet.includes(theme.fg("accent", "\u{f418}")), "the branch icon is the one resting accent");
  const states = { open: "warning", draft: "muted", merged: "syntaxKeyword", closed: "error" };
  for (const [state, color] of Object.entries(states)) {
    const [, top] = hud.hudRows(theme, { ...place, pullRequest: { ...place.pullRequest, state } }, telemetry, 200, false);
    assert.ok(top.includes(theme.fg(color, "#286")), state);
  }
  const [, top] = hud.hudRows(theme, place, telemetry, 120, false);
  assert.ok(top.includes(theme.fg("toolDiffAdded", "+120")) && top.includes(theme.fg("toolDiffRemoved", "−30")));
  assert.ok(top.includes(theme.getThinkingBorderColor("high")("high")), "the editor border color of the thinking level");
  for (const [percent, color] of [[59, "text"], [60, "warning"], [85, "error"]]) {
    const [, , bottom] = hud.hudRows(theme, place, { ...telemetry, context: { percent } }, 120, false);
    assert.ok(bottom.includes(theme.fg(color, `${percent}%`)), `${percent}% in ${color}`);
  }
});

await claim("cache hit rates keep one decimal and the clock has two spaces after its icon, warm or stale", () => {
  for (const [cacheHit, expected] of [[92.4, "92.4%"], [92.46, "92.5%"], [0, "0.0%"], [100, "100.0%"]])
    assert.ok(plain(hud.hudRows(theme, place, { ...telemetry, cacheHit }, 160, false)[2]).includes(expected));
  assert.ok(plain(hud.hudRows(theme, place, telemetry, 160, false)[2]).includes("\u{f0954}  3:12"));
  const cold = plain(hud.hudRows(theme, place, { ...telemetry, clock: "cold" }, 160, false)[2]);
  assert.ok(cold.includes("\u{f0717}  stale") && !/\d:\d\d/.test(cold), cold);
  assert.equal(hud.formatClock(300_000), "5:00");
  assert.equal(hud.formatClock(61_001), "1:02");
  assert.equal(hud.formatClock(1), "0:01");
});

await claim("icons occupy one column and no glyph stretches over the full cell height", () => {
  const all = hud.hudRows(theme, place, telemetry, 200, false).map(plain).join(" ") + at("coordinator", 120).map(plain).join(" ");
  for (const codepoint of [0xf07b, 0xf418, 0xf407, 0xf0645, 0xee9c, 0xf0954]) {
    const icon = String.fromCodePoint(codepoint);
    assert.ok(all.includes(`${icon}  `), icon);
    assert.equal(width(icon), 1);
  }
  assert.ok(!/[\u2502\u2503\u2551\u2580-\u259f\ue0a0]/u.test(all), all);
  assert.equal(plain(hud.contextBar(theme, 50, 4)), "━━──");
  assert.equal(plain(hud.contextBar(theme, 100, 4)), "━━━━");
});

await claim("icons and the resting gauge carry pine, values carry luminance, and color otherwise marks state", () => {
  const [, first, second] = hud.hudRows(theme, place, telemetry, 200, false);
  assert.ok(first.includes(`${theme.fg("accent", "\u{f418}")}  ${theme.fg("text", place.branch)}`), "branch icon in accent, name in text");
  for (const glyph of ["\u{f0645}", "\u{ee9c}"]) assert.ok(second.includes(theme.fg("syntaxType", glyph)), glyph);
  assert.ok(second.includes(theme.italic(theme.fg("muted", place.session))), "session in italic");
  assert.ok(second.includes(theme.fg("text", "$0.53")) && second.includes(theme.fg("muted", "92.4%")));
  assert.ok(hud.contextBar(theme, 28, 10).startsWith(theme.fg("syntaxType", "━━━")), "pine at rest");
  assert.ok(hud.contextBar(theme, 70, 10).startsWith(theme.getFgAnsi("warning")) && hud.contextBar(theme, 90, 10).startsWith(theme.getFgAnsi("error")));
  const spark = hud.sparkline(theme, telemetry.runs);
  assert.equal(spark, theme.fg("muted", plain(spark).slice(0, -1)) + theme.fg("success", "⣦"), "history in muted, the latest run in foam");
  const clock = (remainingMs) => hud.hudRows(theme, place, { ...telemetry, clock: { remainingMs } }, 200, false)[2];
  assert.ok(clock(192_000).includes(theme.fg("success", "\u{f0954}")) && clock(59_000).includes(theme.fg("warning", "\u{f0954}")));
});

await claim("a running tool shows its name like a transcript tool call and its target in muted", () => {
  const [first, second] = at("running", 120);
  assert.ok(first.includes(theme.fg("toolTitle", "read") + theme.fg("muted", " src/work-controller.ts")), JSON.stringify(first));
  assert.ok(second.includes(theme.italic(theme.fg("thinkingText", "writing…"))), JSON.stringify(second));
});

await claim("folder, branch and pull request link to GitHub when the terminal supports it", () => {
  const [, linked] = hud.hudRows(theme, place, telemetry, 200, true);
  assert.ok(linked.includes(tui.hyperlink(`${theme.fg("syntaxType", "\u{f07b}")}  ${theme.bold(theme.fg("text", "dev"))}`, place.repoUrl)), JSON.stringify(linked));
  assert.ok(linked.includes(`${place.repoUrl}/tree/feat/285-subagent-visibility`));
  assert.ok(linked.includes(place.pullRequest.url));
  const [, bare] = hud.hudRows(theme, place, telemetry, 200, false);
  assert.ok(!bare.includes("\x1b]8;"));
});

const usage = (totalTokens, cacheRead, input, cost) => ({
  input, output: totalTokens - input - cacheRead, cacheRead, cacheWrite: 0, totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const stamp = (seconds) => new Date(Date.UTC(2026, 9, 7, 12, 0, seconds)).toISOString();
const userEntry = (seconds) => ({ type: "message", timestamp: stamp(seconds), message: { role: "user", content: "x", timestamp: 0 } });
const assistantEntry = (seconds, u) => ({ type: "message", timestamp: stamp(seconds), message: { role: "assistant", usage: u } });

await claim("session statistics group runs per prompt and follow the latest request", () => {
  const branch = [
    userEntry(0), assistantEntry(1, usage(100, 0, 100, 0.01)), assistantEntry(2, usage(300, 200, 50, 0.02)),
    userEntry(3), assistantEntry(4, usage(1000, 900, 100, 0.03)),
    { type: "usage", timestamp: stamp(9), kind: "cache_warm", usage: usage(10, 9, 1, 0.001) },
  ];
  const result = stats.sessionStats([...branch, assistantEntry(5, usage(1, 0, 1, 1))], branch);
  assert.deepEqual(result.runs, [400, 1000]);
  assert.equal(Math.round(result.cacheHit), 90);
  assert.equal(result.lastRequestAt, Date.parse(stamp(9)));
  assert.equal(result.cost.toFixed(3), "1.061");
  assert.equal(stats.cacheRemaining(result.lastRequestAt, result.lastRequestAt + 60_000), 240_000);
  assert.deepEqual(stats.sessionStats([], []), { cost: 0, runs: [] });
});

await claim("every session append moves the leaf, so the statistics cache key sees cache-warm usage", () => {
  const manager = pi.SessionManager.inMemory("/tmp");
  const leaves = new Set([manager.getLeafId()]);
  manager.appendMessage({ role: "user", content: "x", timestamp: 0 });
  leaves.add(manager.getLeafId());
  manager.appendUsage("cache_warm", "anthropic", "claude-opus-5-5", usage(10, 9, 1, 0.001));
  leaves.add(manager.getLeafId());
  assert.equal(leaves.size, 3);
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const scratchRepo = () => {
  const root = mkdtempSync(join(tmpdir(), "dev-footer-repo-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore", env: gitEnv });
  git("init", "-q", "-b", "main");
  return { root, git };
};

await claim("only GitHub origins become links and live linked worktrees are counted", async () => {
  const config = (url) => `[remote "origin"]\n\turl = ${url}\n`;
  assert.equal(repo.githubUrl(config("git@github.com:taekwondodev/dev.git")), "https://github.com/taekwondodev/dev");
  assert.equal(repo.githubUrl(config("git@gitlab.com:a/b.git")), undefined);
  const { root, git } = scratchRepo();
  try {
    git("commit", "-q", "--allow-empty", "-m", "init");
    git("remote", "add", "origin", "git@github.com:o/r.git");
    git("worktree", "add", "-q", join(root, "..", `${root.split("/").pop()}-a`));
    const facts = await repo.readRepoFacts(root);
    assert.equal(facts.url, "https://github.com/o/r");
    assert.equal(facts.worktrees, 1);
    rmSync(join(root, "..", `${root.split("/").pop()}-a`), { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await claim("repository, branch and session text cannot drive the terminal: the HUD drops control characters and links only plain GitHub names", () => {
  const config = (url) => `[remote "origin"]\n\turl = ${url}\n`;
  // An origin that would write `rm -rf ~` to the clipboard, a branch that sets the title and clears the screen.
  assert.equal(repo.githubUrl(config("https://github.com/mario/progetto\x1b]52;c;cm0gLXJmIH4=\x07")), undefined);
  assert.equal(repo.githubUrl(config("https://github.com/mario/progetto.git")), "https://github.com/mario/progetto");
  assert.equal(repo.githubUrl(config("git@github.com:my.org/my_repo-2.git")), "https://github.com/my.org/my_repo-2");
  const hostile = "x\x1b]52;c;cm0gLXJmIH4=\x07\x1b]0;tutto ok\x07\x1b[2J\x9b2J\n\ty";
  const rows = hud.hudRows(theme, {
    ...place,
    folder: hostile,
    branch: hostile,
    session: hostile,
    model: hostile,
    repoUrl: `https://github.com/o/r${hostile}`,
    pullRequest: { ...place.pullRequest, url: `https://github.com/o/r/pull/1${hostile}` },
  }, telemetry, 220, true);
  assert.ok(rows.some((row) => plain(row).includes("x ")), rows.map(plain).join("\n"));
  // The HUD's own escapes are SGR colors and OSC 8 links; anything else leaked.
  const own = (row) => row.replaceAll(/\x1b\]8;;[^\x1b\x07]*\x1b\\/gu, "").replaceAll(/\x1b\[[0-9;]*m/gu, "");
  assert.deepEqual(rows.filter((row) => /\p{Cc}/u.test(own(row))), []);
});

await claim("the diff counts staged, unstaged and untracked lines without writing the index; no commit means no diff", async () => {
  const { root, git } = scratchRepo();
  try {
    writeFileSync(join(root, "a.txt"), "one\n");
    assert.equal((await repo.readRepoFacts(root)).diff, undefined);
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(join(root, "new.txt"), "a\nb\nc");
    const index = statSync(join(root, ".git/index")).mtimeMs;
    assert.deepEqual((await repo.readRepoFacts(root)).diff, { added: 1 + 3, removed: 0 });
    assert.equal(statSync(join(root, ".git/index")).mtimeMs, index);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await claim("gh runs only off the default branch, at most once a minute per branch, and never during render", async () => {
  const { root, git } = scratchRepo();
  const bin = mkdtempSync(join(tmpdir(), "dev-footer-bin-"));
  const calls = join(bin, "calls");
  const path = process.env.PATH;
  let branch = "main";
  const pi = await installExtension({ cwd: root, branch: () => branch });
  const count = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);
  try {
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> '${calls}'\necho '{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":false}'\n`);
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${path}`;
    git("commit", "-q", "--allow-empty", "-m", "init");
    git("remote", "add", "origin", "git@github.com:o/r.git");
    mkdirSync(join(root, ".git/refs/remotes/origin"), { recursive: true });
    writeFileSync(join(root, ".git/refs/remotes/origin/HEAD"), "ref: refs/remotes/origin/main\n");
    pi.start();
    await settle(() => false);
    for (let index = 0; index < 20; index++) pi.footer.render(160);
    assert.equal(count(), 0, "no lookup on the default branch");
    branch = "feature";
    pi.handlers.get("turn_end")({}, pi.ctx);
    await settle(() => plain(pi.footer.render(200)[1]).includes("#7"));
    assert.ok(plain(pi.footer.render(200)[1]).includes("#7"));
    for (let index = 0; index < 5; index++) {
      pi.handlers.get("turn_end")({}, pi.ctx);
      pi.handlers.get("agent_end")({}, pi.ctx);
    }
    await settle(() => false);
    assert.equal(count(), 1);
    branch = "main";
    assert.ok(!plain(pi.footer.render(200)[1]).includes("#7"), "the pull request follows its branch");
  } finally {
    process.env.PATH = path;
    pi.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

const workDefinition = (resolve = (name) => (name === "work" ? rows.workRenderers() : undefined)) => resolve("work", () => undefined);
const toolRow = (args, result) => {
  const component = new pi.ToolExecutionComponent("work", `id-${Math.random()}`, args, {}, workDefinition(), { requestRender() {} }, "/repo");
  component.markExecutionStarted();
  component.setArgsComplete();
  if (result !== undefined) component.updateResult({ content: result.content ?? [], details: result.details ?? {}, isError: result.isError ?? false, durationMs: 10 }, false);
  return component;
};
const content = (component, columns = 120) => component.render(columns).map(plain).filter((line) => line.trim() !== "").map((line) => line.trim());
const outcomeRow = (message) => new pi.CustomMessageComponent(message, rows.outcomeRenderer);

await claim("only dev-footer resolves the work renderer, and other tools pass through", async () => {
  const pi = await installExtension();
  try {
    const [resolver] = pi.toolRenderers;
    assert.equal(resolver("read", () => "next"), "next");
    assert.equal(typeof resolver("work", () => undefined).renderCall, "function");
    assert.equal(pi.messageRenderers.get("dev/work-outcome"), rows.outcomeRenderer);
  } finally {
    pi.stop();
  }
});

await claim("a delegation renders a static one-line launch row with thinking only when requested", () => {
  const real = resultFor("look-around");
  const launch = toolRow(real.input, real);
  assert.deepEqual(content(launch), ["reader  look around   work-child · read-only"]);
  const requested = { ...real.details, attempt: { ...real.details.attempt, requested: { model: "anthropic/claude-opus-5-5", effort: "high" } } };
  const thinking = toolRow({ ...real.input, skill: "investigation" }, { ...real, details: requested });
  assert.deepEqual(content(thinking), ["investigation  look around   opus-5-5 · high · read-only"]);
  assert.ok(thinking.render(120).some((line) => line.includes(theme.fg("thinkingHigh", "high"))), "the level in its thinking color");
  assert.deepEqual(content(toolRow({ ...real.input, prompt: "/skill:code-review Review it", access: "write" })), ["code-review  look around"]);
  const header = launch.render(120).find((line) => plain(line).includes("reader"));
  assert.ok(header.includes(theme.bold(theme.fg("accent", "reader"))) && header.includes(theme.fg("text", "look around")));
});

await claim("an outcome block summarizes a result contract by its lists and a prose answer by its first line", () => {
  const real = outcomeFor("look-around");
  const lines = content(outcomeRow(real));
  assert.equal(lines[0], "✓ reader  look around");
  assert.match(lines[1], /^work-child · off · 3 turns · 3 calls · \d+\.\dk tokens · \ds$/u, lines[1]);
  assert.match(lines[2], /^└ evidence\/1 · complete · 3 findings · 1 limits {3,}ctrl\+o$/u, lines[2]);
  assert.equal(lines.length, 3);
  const [, raw] = outcomeRow(real).render(120).filter((line) => plain(line).trim() !== "");
  assert.equal(width(raw), 120, "the hint reaches the right edge of the block");
  const prose = structuredClone(real);
  prose.details.outcomes[0].logs[0].text = "\n\nThe answer in prose.\nMore detail.";
  assert.match(content(outcomeRow(prose))[2], /^└ The answer in prose\. {3,}ctrl\+o$/u);
  const quiet = structuredClone(real);
  Object.assign(quiet.details.children[0], { turns: 1, toolUses: 0 });
  assert.match(content(outcomeRow(quiet))[1], /^work-child · off · 1 turn · \d+\.\dk tokens/u, "no call count at zero");
});

await claim("a failed child shows its error and a command outcome is one row with exit code and duration", () => {
  const failed = content(outcomeRow(outcomeFor("broken-child")));
  assert.match(failed[0], /^✗ /u);
  assert.match(failed[2], /^└ 400 invalid request: malformed tool schema/u, failed[2]);
  toolRow(resultFor("npm-check").input, resultFor("npm-check"));
  const command = content(outcomeRow(outcomeFor("npm-check")));
  assert.equal(command.length, 1, command.join("\n"));
  assert.match(command[0], /^✓ \$ printf 'lint ok\\nformat ok\\n' {2}exit 0 · \ds · ctrl\+o per l'output$/u, command[0]);
  const expanded = outcomeRow(outcomeFor("npm-check"));
  expanded.setExpanded(true);
  assert.ok(content(expanded).includes("lint ok"));
});

await claim("ctrl+o shows the child's tool trail, read once from its session file, then the answer", async () => {
  const [, lookSession] = transcript.sessions;
  const file = join(scratch, "trail.jsonl");
  copyFileSync(join(fixtures, transcript.sessions.find((name) => name.startsWith(outcomeFor("look-around").details.children[0].id))), file);
  const message = withSession(outcomeFor("look-around"), file);
  const before = opens;
  const row = outcomeRow(message);
  row.setExpanded(true);
  await settle(() => content(row).some((line) => line.startsWith("1   ")));
  const lines = content(row);
  const trail = lines.indexOf("Child work");
  assert.ok(trail > 0, lines.join("\n"));
  assert.deepEqual(lines.slice(trail + 1, trail + 3), ["1   read tracked.txt · grep committed", "2   ls ."]);
  assert.equal(lines[trail + 3], "Answer");
  assert.equal(lines[trail + 4], "```json");
  assert.equal(opens - before, 1, "one read");
  rmSync(file);
  const again = outcomeRow(message);
  again.setExpanded(true);
  for (let frame = 0; frame < 100; frame++) again.render(120);
  assert.ok(content(again).includes("2   ls ."), "the cached read survives the file");
  assert.equal(opens - before, 1, "render() opens nothing");
  assert.equal(lookSession !== undefined, true);
});

await claim("a missing or oversized session file is reported instead of the trail", async () => {
  const missing = outcomeRow(withSession(outcomeFor("look-around"), join(scratch, "absent.jsonl")));
  missing.setExpanded(true);
  await settle(() => content(missing).some((line) => line.includes("unavailable")));
  assert.ok(content(missing).includes("child session unavailable"), content(missing).join("\n"));
  const big = join(scratch, "big.jsonl");
  writeFileSync(big, "");
  truncateSync(big, session.SESSION_LIMIT_BYTES + 1);
  const oversized = outcomeRow(withSession(outcomeFor("look-around"), big));
  oversized.setExpanded(true);
  await settle(() => content(oversized).some((line) => line.includes("troppo grande")));
  assert.ok(content(oversized).some((line) => /^child session too large \(8\.0 MB\)$/u.test(line)), content(oversized).join("\n"));
  assert.ok(content(oversized).includes("Answer"), "the answer still comes from the outcome");
});

await claim("trail targets follow dev's allowlist and redaction: no command text, secrets and opaque URL segments redacted, at most 120 characters", () => {
  assert.equal(session.trailItem("bash", { command: "curl -H 'Authorization: secret'" }, "/repo"), "bash");
  assert.equal(session.trailItem("codemode", { code: "const token = 'secret'" }, "/repo"), "codemode");
  assert.equal(session.trailItem("read", { path: "/repo/src/a.ts" }, "/repo"), "read src/a.ts");
  assert.equal(
    session.trailItem("read_url", { url: "https://user:pass@api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage?chat=1#x" }, "/repo"),
    "read_url https://api.telegram.org/[redacted]/sendMessage",
  );
  assert.equal(session.trailItem("read_url", { url: "https://docs.example/getting-started-with-effect" }, "/repo"), "read_url https://docs.example/getting-started-with-effect");
  assert.equal(session.trailItem("grep", { pattern: "api_key=abc123" }, "/repo"), "grep api_key=[redacted]");
  assert.equal(session.trailItem("read", { path: "keys/sk-abcdefghijklmnop.txt" }, "/repo"), "read keys/[redacted].txt");
  const long = session.trailItem("read", { path: "🙂".repeat(200) }, "/repo");
  assert.equal([...long.slice("read ".length)].length, session.TARGET_LIMIT);
});

await claim("a truncated answer is summarized from the session file once it is read", async () => {
  const file = join(scratch, "truncated.jsonl");
  copyFileSync(join(fixtures, transcript.sessions.find((name) => name.startsWith(outcomeFor("look-around").details.children[0].id))), file);
  const message = withSession(structuredClone(outcomeFor("look-around")), file);
  message.details.outcomes[0].logs[0] = { ...message.details.outcomes[0].logs[0], text: "only the tail", truncated: true };
  const row = outcomeRow(message);
  assert.match(content(row)[2], /^└ … {3,}ctrl\+o$/u);
  await settle(() => content(row)[2].includes("evidence/1"));
  assert.match(content(row)[2], /^└ evidence\/1 · complete · 3 findings · 1 limits/u, content(row)[2]);
});

await claim("other actions and their results are compact rows", () => {
  toolRow(resultFor("look-around").input, resultFor("look-around"));
  const id = resultFor("look-around").details.attempt.id;
  const page = toolRow({ action: "inspect", id, stream: "result", offset: 0 }, {
    content: [{ type: "text", text: "{}" }],
    details: { kind: "log", log: { stream: "result", available: true, text: "x".repeat(12288), truncated: true, nextOffset: 12288 } },
  });
  assert.deepEqual(content(page), ["work inspect  reader look around · result da 0", "12.0 KB letti · continua da 12288   ctrl+o per leggere"]);
  const inspection = toolRow({ action: "inspect", id }, { details: { kind: "inspection", inspection: { ...resultFor("look-around").details.attempt, status: "completed", exitCode: 0, staleArtifact: false, logs: [], record: {} } } });
  assert.deepEqual(content(inspection), ["work inspect  reader look around", "✓ completed · exit 0"]);
  const listing = toolRow({ action: "list" }, { details: { kind: "snapshot", snapshot: { records: [{ ...resultFor("look-around").details.attempt, status: "completed" }, { ...resultFor("npm-check").details.attempt }], unavailable: [], agentsBlocked: true, total: 2, nextOffset: null } } });
  assert.deepEqual(content(listing), ["work list", "1 running · 1 completed · new agents blocked"]);
  const dispatch = toolRow({ action: "dispatch" }, { details: { kind: "dispatch", dispatch: { path: "/x", configured: true, default: { harness: "pi", model: "anthropic/claude-sonnet-5-5" }, rules: { "code-review": { harness: "pi", model: "openai/gpt-6", effort: "high" } } } } });
  assert.deepEqual(content(dispatch), ["work dispatch", "default sonnet-5-5 · 1 regole"]);
  const cancel = toolRow({ action: "cancel", id }, { details: { kind: "attempt", attempt: { ...resultFor("look-around").details.attempt, status: "cancelled" } } });
  assert.deepEqual(content(cancel), ["work cancel  reader look around", "⊘ cancelled"]);
  const refused = toolRow({ action: "delegate", taskId: "blocked" }, { content: [{ type: "text", text: "Subscription exhausted; no new agents may start in this session" }], isError: true });
  assert.deepEqual(content(refused), ["reader  blocked", "Subscription exhausted; no new agents may start in this session"]);
  const process = toolRow(resultFor("npm-check").input, resultFor("npm-check"));
  assert.deepEqual(content(process), ["$ printf 'lint ok\\nformat ok\\n'  npm check"]);
});

await claim("child and command text cannot drive the terminal: the list, the work rows, outcomes and the trail drop control characters", async () => {
  // OSC 52 clipboard write, OSC 0 title, a color the theme never uses, CSI clear screen,
  // a C1 CSI and a carriage return. Sanitized, each control becomes a space after `x`.
  const hostile = "x\x1b]52;c;b3duZWQ=\x07\x1b]0;owned\x07\x1b[5;31m\x1b[2J\x9b2J\ry";
  const surfaces = new Map();
  const draw = (name, lines, marker = "x ") => surfaces.set(name, { lines, marker });

  const pi = await installExtension({ sessionId: scene("running").sessionId });
  try {
    pi.start();
    const [tool, writing] = scene("running").children;
    pi.events.emit("dev/work-view", {
      ...scene("running"),
      children: [
        { ...tool, taskId: `${hostile}\n\tz`, skill: `${hostile}\n`, model: `${hostile}\t`, activity: { kind: "tool", name: hostile, target: hostile } },
        { ...writing, activity: { kind: "retrying", message: hostile } },
        { ...tool, id: "failed", status: "failed", error: hostile, activity: undefined },
      ],
    });
    draw("list", pi.widget().render(160));
    // Each child is one row: newlines and tabs in its fields do not add or shift rows.
    assert.deepEqual(pi.widget().render(160).filter((line) => /[\n\t]/u.test(line)), []);
  } finally {
    pi.stop();
  }

  const look = resultFor("look-around");
  draw("delegate row", toolRow({ ...look.input, taskId: hostile, skill: hostile }, look).render(120));
  draw("process row", toolRow({ action: "process", command: hostile, taskId: hostile }, resultFor("npm-check")).render(120));
  draw("error row", toolRow({ action: "delegate", taskId: "x" }, { content: [{ type: "text", text: hostile }], isError: true }).render(120));
  const page = toolRow({ action: "inspect", id: hostile, stream: "result" }, { details: { kind: "log", log: { stream: "result", available: true, text: hostile, nextOffset: null } } });
  page.setExpanded(true);
  draw("log page", page.render(120));
  const dispatch = toolRow({ action: "dispatch" }, { details: { kind: "dispatch", dispatch: { default: { model: hostile }, rules: { [hostile]: { model: hostile, effort: hostile } } } } });
  dispatch.setExpanded(true);
  draw("dispatch", dispatch.render(120));

  const answer = structuredClone(outcomeFor("look-around"));
  answer.details.outcomes[0].logs[0].text = `${hostile}\n${hostile}`;
  // Escapes that JSON decoding turns back into controls after the payload was sanitized.
  const contract = structuredClone(outcomeFor("look-around"));
  contract.details.outcomes[0].logs[0].text = '```json\n{"format":"a\\u001b]0;owned\\u0007","status":"b","\\u001b[2J":[]}\n```';
  const failed = structuredClone(outcomeFor("broken-child"));
  failed.details.outcomes[0].error = hostile;
  const command = structuredClone(outcomeFor("npm-check"));
  command.details.outcomes[0].error = hostile;
  for (const log of command.details.outcomes[0].logs) log.text = hostile;
  for (const [name, message, marker] of [["answer", answer], ["result contract", contract, "a ]0;owned"], ["failed child", failed], ["command", command]]) {
    draw(`${name} outcome`, outcomeRow(message).render(120), marker);
    const expanded = outcomeRow(message);
    expanded.setExpanded(true);
    draw(`${name} outcome expanded`, expanded.render(120), name === "result contract" ? "a\\u001b" : marker);
  }

  const file = join(scratch, "hostile.jsonl");
  const entry = (message) => JSON.stringify({ type: "message", message });
  writeFileSync(file, [
    JSON.stringify({ type: "session", cwd: "/repo" }),
    entry({ role: "assistant", content: [{ type: "toolCall", id: "1", name: hostile, arguments: {} }, { type: "toolCall", id: "2", name: "read", arguments: { path: hostile } }] }),
    entry({ role: "assistant", content: [{ type: "text", text: hostile }] }),
  ].join("\n"));
  const trail = outcomeRow(withSession({ ...answer, details: { ...answer.details, outcomes: [{ ...answer.details.outcomes[0], logs: [] }] } }, file));
  trail.setExpanded(true);
  await settle(() => content(trail).some((line) => line.startsWith("1   ")));
  draw("trail", trail.render(120).filter((line) => plain(line).trim().startsWith("1   ")));

  // The theme draws only SGR colors; any other control, or the hostile color, leaked.
  const leaked = (line) => line.includes("\x1b[5;31m") || /[^\P{Cc}\n\t]/u.test(line.replaceAll(/\x1b\[[0-9;]*m/gu, ""));
  for (const [name, { lines, marker }] of surfaces) {
    assert.ok(lines.some((line) => plain(line).includes(marker)), `${name} draws the hostile text: ${lines.map(plain).join("\n")}`);
    assert.deepEqual(lines.filter(leaked), [], name);
  }
});

await claim("one list frame and one HUD frame stay far below a 16 ms frame budget", () => {
  const frames = 5_000;
  const start = performance.now();
  for (let index = 0; index < frames; index++) {
    const columns = 80 + (index % 120);
    list.listRows(theme, scene("many"), columns, sceneAt("many"), index);
    hud.hudRows(theme, place, telemetry, columns, true);
  }
  const frameMs = (performance.now() - start) / frames;
  console.log(`# frame ${(frameMs * 1000).toFixed(1)} µs`);
  assert.ok(frameMs < 1, `${frameMs} ms per frame`);
});

rmSync(scratch, { recursive: true, force: true });
if (failures > 0) {
  console.log(`${failures} claim(s) failed`);
  process.exit(1);
}
