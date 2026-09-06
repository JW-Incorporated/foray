/* Idempotent skip-if-already-built state tests. */
import test from "node:test";
import assert from "node:assert/strict";
import { alreadyBuilt, nextState } from "./state.mjs";

test("alreadyBuilt: false when no prior state", () => {
  assert.equal(alreadyBuilt(null, { exportVersion: "v1", checksum: "abc" }), false);
});

test("alreadyBuilt: true when both export_version and checksum match", () => {
  const state = { export_version: "v1", checksum: "abc" };
  assert.equal(alreadyBuilt(state, { exportVersion: "v1", checksum: "abc" }), true);
});

test("alreadyBuilt: false when checksum differs even though export_version matches (re-publish under an unchanged header)", () => {
  const state = { export_version: "v1", checksum: "abc" };
  assert.equal(alreadyBuilt(state, { exportVersion: "v1", checksum: "different" }), false);
});

test("alreadyBuilt: false when export_version differs", () => {
  const state = { export_version: "v1", checksum: "abc" };
  assert.equal(alreadyBuilt(state, { exportVersion: "v2", checksum: "abc" }), false);
});

test("nextState: carries forward previous_export_version", () => {
  const prev = { export_version: "v1", checksum: "abc" };
  const state = nextState(prev, { exportVersion: "v2", checksum: "def", builtAt: "2026-09-05T00:00:00Z", counts: { kept: 1 } });
  assert.equal(state.previous_export_version, "v1");
  assert.equal(state.export_version, "v2");
  assert.equal(state.checksum, "def");
  assert.deepEqual(state.counts, { kept: 1 });
});

test("nextState: previous_export_version is null on a first build", () => {
  const state = nextState(null, { exportVersion: "v1", checksum: "abc", builtAt: "now" });
  assert.equal(state.previous_export_version, null);
});
