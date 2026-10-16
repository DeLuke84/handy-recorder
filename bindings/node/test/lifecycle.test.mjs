// Process lifecycle, each case in a process of its own (test/fixtures/):
// exiting, signals, uncaught errors, worker threads, and loading through
// jiti with reloads, as pi loads extensions. Needs the test build.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, run, runtimeName, test } from "./harness.mjs";

console.log(`# lifecycle (${runtimeName})`);
const windows = process.platform === "win32";

function ok(result) {
  assert.equal(result.timedOut, false, `hung; output:\n${result.stdout}${result.stderr}`);
  assert.equal(result.code, 0, `exit ${result.code ?? result.signal}; output:\n${result.stdout}${result.stderr}`);
}

// A crash in native code shows up as one of these, never as an exit code.
function notCrashed(result) {
  assert.ok(
    !["SIGSEGV", "SIGBUS", "SIGABRT", "SIGILL"].includes(result.signal),
    `crashed with ${result.signal}; output:\n${result.stdout}${result.stderr}`,
  );
}

test("nothing left behind keeps the process alive", async () => {
  const result = await fixture("exits-on-its-own");
  ok(result);
  assert.match(result.stdout, /open failed: DeviceBusy\nopen failed: OpenTimedOut\nclose failed: CloseTimedOut\nrecorded 20 times/);
  assert.ok(result.ms < 5_000, `took ${Math.round(result.ms)} ms to exit`);
});

test("a recording keeps the process alive until stopped", async () => {
  const result = await fixture("recording-keeps-alive");
  ok(result);
  assert.match(result.stdout, /samples [1-9]\d*/);
  assert.match(result.stdout, /closed/);
});

test("process.exit mid-recording exits promptly", async () => {
  const result = await fixture("ends-mid-recording", { args: ["exit"] });
  notCrashed(result);
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 7, result.stderr);
});

test("an uncaught exception mid-recording exits promptly", async () => {
  const result = await fixture("ends-mid-recording", { args: ["throw"] });
  notCrashed(result);
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /uncaught mid-recording/);
});

test("an unhandled rejection mid-recording exits promptly", async () => {
  const result = await fixture("ends-mid-recording", { args: ["reject"] });
  notCrashed(result);
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unhandled mid-recording/);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} mid-recording ends the process`, async () => {
    const result = await fixture("ends-mid-recording", { args: ["signal"], signalOnReady: signal });
    notCrashed(result);
    assert.equal(result.timedOut, false, "hung after the signal");
    assert.match(result.stdout, /ready [1-9]/);
    // Killed by the signal, not exited on its own before it arrived.
    assert.ok(result.signal === signal || result.code !== 0, `exit ${result.code ?? result.signal}`);
  }, { skip: windows && "no POSIX signals on Windows" });
}

for (const [mode, message] of [["chunk", /boom from onChunk/], ["log", /boom from the log handler/]]) {
  test(`a throwing ${mode === "chunk" ? "onChunk" : "log handler"} is an ordinary uncaught exception`, async () => {
    const result = await fixture("throws", { args: [mode] });
    notCrashed(result);
    assert.equal(result.timedOut, false);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, message);
  });
}

test("a log handler whose worker exited is dropped harmlessly", async () => {
  const result = await fixture("log-worker", { timeout: 20_000 });
  ok(result);
  assert.match(result.stdout, /worker logged [1-9]\d* records/);
  assert.match(result.stdout, /main recorded [1-9]\d* samples with the worker's handler gone/);
  assert.match(result.stdout, /main logged [1-9]\d* records/);
});

test("worker threads: record, and terminate one mid-recording", async () => {
  const result = await fixture("worker", { timeout: 20_000 });
  ok(result);
  assert.match(result.stdout, /worker recorded [1-9]\d* samples, complete true/);
  assert.match(result.stdout, /terminated a worker mid-recording/);
  assert.match(result.stdout, /main recorded [1-9]\d* samples/);
});

test("loaded through jiti, reloaded while recording (as pi does)", async () => {
  const result = await fixture("jiti", { timeout: 20_000 });
  ok(result);
  assert.match(result.stdout, /reloaded: new module instance true/);
  assert.match(result.stdout, /first [1-9]\d* complete true; second [1-9]\d* complete true/);
});

// Lays the package out in dir as npm installs it: the test build in its
// platform package, and extension.ts importing the package by name. Loading
// it without HANDY_RECORDER_NATIVE goes through native.js's resolution.
function install(dir) {
  const { HANDY_RECORDER_NATIVE: build, ...env } = process.env;
  const suffix = basename(build).replace(/^recorder\.|\.node$/g, "");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const main = join(dir, "node_modules", pkg.name);
  const platform = `${main}-${suffix}`;
  mkdirSync(main, { recursive: true });
  mkdirSync(platform);
  for (const file of ["index.js", "native.js"]) copyFileSync(join(root, file), join(main, file));
  pkg.optionalDependencies = { [`${pkg.name}-${suffix}`]: pkg.version };
  writeFileSync(join(main, "package.json"), JSON.stringify(pkg));
  copyFileSync(build, join(platform, `recorder.${suffix}.node`));
  const platformPkg = { name: `${pkg.name}-${suffix}`, version: pkg.version, main: `recorder.${suffix}.node` };
  writeFileSync(join(platform, "package.json"), JSON.stringify(platformPkg));
  const extension = readFileSync(join(root, "test", "fixtures", "extension.ts"), "utf8");
  writeFileSync(join(dir, "extension.ts"), extension.replace('"../../index.js"', `"${pkg.name}"`));
  return { extension: join(dir, "extension.ts"), env };
}

// pi also ships as a `bun build --compile` binary, which loads extensions
// from disk through jiti. The result doesn't depend on the runtime running
// these tests, so it runs once, under Bun.
test("loaded by a compiled Bun binary through jiti (pi's binary)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handy-recorder-pi-host-"));
  try {
    const host = join(dir, process.platform === "win32" ? "pi-host.exe" : "pi-host");
    const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
    const build = spawnSync(process.execPath, ["build", "--compile", join(fixtures, "pi-host.mjs"), "--outfile", host], {
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr);
    const { extension, env } = install(dir);
    const result = spawnSync(host, [extension], { encoding: "utf8", timeout: 20_000, env });
    assert.equal(result.status, 0, `${result.signal ?? ""}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /host: compiled true/);
    assert.match(result.stdout, /extension: [1-9]\d* samples, [1-9]\d* chunks, complete true/);
  } finally {
    // Windows can hold the exited binary for a moment. A leftover temp
    // directory isn't a test failure.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  }
}, { timeout: 60_000, skip: !process.versions.bun && "runs under Bun only" });

await run();
