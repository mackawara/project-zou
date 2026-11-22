import assert from "node:assert/strict";
import test from "node:test";
import { guideButtons, guides, menu, overview, welcome } from "../src/guide";

test("help messages fit WhatsApp interactive limits", () => {
  for (const body of [welcome, menu, overview, ...Object.values(guides)]) assert.ok(body.length <= 1024, body.slice(0, 40));
  for (const { title } of guideButtons) assert.ok(title.length <= 20, title);
  assert.ok(guideButtons.length <= 3);
});
