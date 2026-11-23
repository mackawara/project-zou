import assert from "node:assert/strict";
import test from "node:test";
import { capacityForm, checkForm, dateAllowed, dateRange, fixList, requestForm, tripForm, truckerForm } from "../src/domain";
import { sendWhatsApp } from "../src/whatsapp";

// 23 Nov 2026, 10:00 in Harare.
const now = new Date("2026-11-23T08:00:00Z");
const search = { pickup: "Harare", dropoff: "Gweru", date: "2026-11-25", cargo: "Produce", weight: "12", notes: "" };
const trip = { origin: "Harare", destination: "Hwange", date: "2026-11-25", time: "07:30", capacity: "20", acceptedCargo: ["Produce"] };
const problems = (result: ReturnType<typeof checkForm>) => result.ok ? [] : result.problems;

test("date pickers and the server share one 30-day window in Harare time", () => {
  assert.deepEqual(dateRange(now), { min: "2026-11-23", max: "2026-12-23" });
  // Just after midnight in Harare is already the next local day.
  assert.deepEqual(dateRange(new Date("2026-11-23T22:30:00Z")), { min: "2026-11-24", max: "2026-12-24" });
  assert.ok(dateAllowed("2026-11-23", now) && dateAllowed("2026-12-23", now));
  assert.ok(!dateAllowed("2026-11-22", now) && !dateAllowed("2026-12-24", now));
});

test("a valid search converts whole tonnes to kilograms", () => {
  const result = checkForm(requestForm, search, now, "load date");
  assert.ok(result.ok);
  assert.equal(result.data.weight, 12_000);
});

test("tonnes must be whole numbers from 1 to 40", () => {
  for (const weight of ["0", "0.5", "2.5", "41", "100", "abc", "", "-3"]) {
    const [problem] = problems(checkForm(requestForm, { ...search, weight }, now, "load date"));
    assert.match(problem, /weight/, weight);
  }
  assert.match(problems(checkForm(requestForm, { ...search, weight: "2.5" }, now))[0], /Decimals are not accepted/);
  assert.match(problems(checkForm(requestForm, { ...search, weight: "41" }, now))[0], /at most 40 tonnes/);
  for (const weight of ["1", "40", " 7 "]) assert.ok(checkForm(requestForm, { ...search, weight }, now).ok, weight);
  assert.equal(capacityForm.parse({ capacity: "0" }).capacity, 0);
  assert.ok(!capacityForm.safeParse({ capacity: "1.5" }).success);
});

test("every problem in a search is listed at once, including the same town and the date", () => {
  const list = problems(checkForm(requestForm, { ...search, dropoff: "Harare", weight: "2.5", date: "2026-12-30" }, now, "load date"));
  assert.equal(list.length, 3);
  assert.match(list.join("\n"), /Decimals are not accepted/);
  assert.match(list.join("\n"), /Pickup and drop-off are the same town/);
  assert.match(list.join("\n"), /too far ahead\. Choose a date up to Wed 23 Dec \(30 days from today\)/);
  assert.match(problems(checkForm(requestForm, { ...search, date: "2026-11-20" }, now, "load date"))[0], /has passed\. Choose today \(Mon 23 Nov\) or later/);
  assert.match(problems(checkForm(requestForm, { ...search, pickup: undefined }, now))[0], /Choose the pickup town from the list/);
});

test("trip and trucker forms name the field and show an example", () => {
  assert.ok(checkForm(tripForm, trip, now, "departure date").ok);
  assert.match(problems(checkForm(tripForm, { ...trip, time: "7.30" }, now))[0], /24-hour format with a colon, for example 07:30/);
  assert.match(problems(checkForm(tripForm, { ...trip, acceptedCargo: [] }, now))[0], /Tick at least one cargo type/);
  assert.match(problems(checkForm(tripForm, { ...trip, destination: "Harare" }, now))[0], /Origin and destination are the same town/);
  const trucker = { name: "Tendai Moyo", nationalId: "63-1234567-F-42", registration: "abc 1234", company: "Moyo Haulage" };
  assert.ok(checkForm(truckerForm, trucker, now).ok);
  const list = problems(checkForm(truckerForm, { ...trucker, name: " ", nationalId: "123", registration: "AB#1" }, now));
  assert.deepEqual(list, [
    "Enter your full name.",
    "Enter your national ID like 63-1234567-F-42: 2 digits, 6 or 7 digits, a letter, then 2 digits.",
    "Use only letters, numbers, spaces and dashes in the truck registration, for example ABC 1234.",
  ]);
  assert.equal(fixList(["One."]), "Please fix this and submit the form again:\n• One.");
});

test("Flow messages carry the date limits for the calendar", async (t) => {
  const keys = ["WA_ACCESS_TOKEN", "WA_GRAPH_VERSION", "WA_PHONE_NUMBER_ID", "WA_FLOW_SEARCH", "WA_FLOW_TRUCKER"];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]));
  Object.assign(process.env, { WA_ACCESS_TOKEN: "test-token", WA_GRAPH_VERSION: "v23.0", WA_PHONE_NUMBER_ID: "123", WA_FLOW_SEARCH: "1", WA_FLOW_TRUCKER: "2" });
  const sent: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return Response.json({});
  });
  const screen = { min_date: "2026-11-23", max_date: "2026-12-23" };
  await sendWhatsApp("263770000000", { kind: "flow", body: "Find", flow: "search", token: "t", screen }, true);
  await sendWhatsApp("263770000000", { kind: "flow", body: "Details", flow: "trucker", token: "t" }, true);
  const payloads = sent.map((body) => body.interactive.action.parameters.flow_action_payload);
  assert.deepEqual(payloads, [{ screen: "FORM", data: screen }, { screen: "FORM" }]);
});
