import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { normalizeConfig } = await load("api");
const { filterProjects, normalizeProjectFilter, includeAddedProject } = await load("projectFilter");
const projects = Object.freeze([
  Object.freeze({ id: "a", name: "Activo", path: "/a", createdAt: 1 }),
  Object.freeze({ id: "b", name: "Favorito", path: "/b", favorite: true, createdAt: 2 }),
  Object.freeze({ id: "c", name: "Otro", path: "/c", createdAt: 3 }),
]);

test("project views support all, dynamic favorites, one project and several, preserving order and identity", () => {
  const ids = value => value.map(project => project.id);
  assert.deepEqual(ids(filterProjects(projects, { mode: "all", projectIds: ["c"] })), ["a", "b", "c"]);
  assert.deepEqual(ids(filterProjects(projects, { mode: "favorites", projectIds: ["c"] })), ["b"]);
  assert.deepEqual(ids(filterProjects(projects, { mode: "selected", projectIds: ["c"] })), ["c"]);
  assert.deepEqual(ids(filterProjects(projects, { mode: "selected", projectIds: ["c", "a"] })), ["a", "c"]);
  assert.deepEqual(filterProjects(projects, { mode: "selected", projectIds: [] }), []);
  const changed = projects.map(project => ({ ...project, favorite: project.id === "a" }));
  assert.deepEqual(ids(filterProjects(changed, { mode: "favorites", projectIds: [] })), ["a"]);
  assert.equal(filterProjects(projects, { mode: "all", projectIds: [] })[0], projects[0]);
});

test("old or malformed views default to all and stale/duplicate project IDs are removed", () => {
  for (const raw of [undefined, null, "favorites", [], 42, { mode: "invalid" }]) {
    assert.deepEqual(normalizeProjectFilter(raw, projects), { mode: "all", projectIds: [] });
  }
  assert.deepEqual(normalizeProjectFilter({ mode: "selected", projectIds: ["b", 3, null, "gone", "b", "a"] }, projects), { mode: "selected", projectIds: ["b", "a"] });
  assert.deepEqual(normalizeProjectFilter({ mode: "selected", projectIds: ["gone"] }, projects), { mode: "selected", projectIds: [] });
});

test("the view survives configuration save/reload without changing active project or background sessions", () => {
  assert.deepEqual(normalizeConfig({}).ui.projectFilter, { mode: "all", projectIds: [] });
  for (const mode of ["all", "favorites", "selected"]) {
    const config = normalizeConfig({ projects, ui: { activeProjectId: "b", projectFilter: { mode, projectIds: ["a", "c", "deleted"] },
      lastTabs: [{ id: "t-one", projectId: "b", kind: "shell", subtitle: "Background" }] } });
    const saved = normalizeConfig(JSON.parse(JSON.stringify(config)));
    assert.deepEqual(saved.ui.projectFilter, { mode, projectIds: ["a", "c"] });
    assert.equal(saved.ui.activeProjectId, "b");
    assert.equal(saved.ui.lastTabs[0].projectId, "b");
    assert.equal(saved.projects.length, 3);
  }
});

test("newly added projects remain reachable in every view", () => {
  assert.deepEqual(includeAddedProject({ mode: "all", projectIds: ["a"] }, "new"), { mode: "all", projectIds: ["a"] });
  assert.deepEqual(includeAddedProject({ mode: "favorites", projectIds: ["a"] }, "new"), { mode: "all", projectIds: ["a"] });
  assert.deepEqual(includeAddedProject({ mode: "selected", projectIds: ["a"] }, "new"), { mode: "selected", projectIds: ["a", "new"] });
});
