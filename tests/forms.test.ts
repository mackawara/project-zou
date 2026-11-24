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

test("a search keeps up to three load photos as media IDs", () => {
  const photo = (id: string, mime_type = "image/jpeg") => ({ file_name: "load.jpg", mime_type, sha256: "abc", id });
  const parsed = (photos: unknown) => checkForm(requestForm, { ...search, photos }, now, "load date");
  const none = checkForm(requestForm, search, now, "load date");
  assert.ok(none.ok && none.data.photos.length === 0);
  const three = parsed([photo("111"), photo("222", "image/png"), { mime_type: "image/jpeg", media_id: "333" }]);
  assert.ok(three.ok);
  assert.deepEqual(three.data.photos, ["111", "222", "333"]);
  for (const photos of [[photo("1"), photo("2"), photo("3"), photo("4")], [photo("1", "application/pdf")], [photo("1", "image/webp")], [photo("../etc")], "photo"]) {
    assert.deepEqual(problems(parsed(photos)), ["Add up to 3 JPEG or PNG photos of the load, each up to 5 MB."], JSON.stringify(photos));
  }
});

test("a photo is copied to a new upload and sent with its caption, only inside the window", async (t) => {
  const keys = ["WA_ACCESS_TOKEN", "WA_GRAPH_VERSION", "WA_PHONE_NUMBER_ID", "WA_UPDATE_TEMPLATE"];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]));
  Object.assign(process.env, { WA_ACCESS_TOKEN: "test-token", WA_GRAPH_VERSION: "v23.0", WA_PHONE_NUMBER_ID: "123", WA_UPDATE_TEMPLATE: "pilot_update" });
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let download = 200;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body });
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer test-token");
    if (url.endsWith("/v23.0/555")) return Response.json({ url: "https://lookaside.example/555", mime_type: "image/png" });
    if (url === "https://lookaside.example/555") return new Response(new Uint8Array([1, 2, 3]), { status: download });
    if (url.endsWith("/123/media")) return Response.json({ id: "999" });
    return Response.json({});
  });
  const image = { kind: "image", mediaId: "555", body: "Photo 1 of 1" } as const;
  await sendWhatsApp("263770000000", image, false);
  assert.equal(calls.length, 0);
  await sendWhatsApp("263770000000", image, true);
  assert.deepEqual(calls.map(({ url, method }) => `${method} ${url.replace("https://graph.facebook.com/v23.0", "")}`),
    ["GET /555", "GET https://lookaside.example/555", "POST /123/media", "POST /123/messages"]);
  const upload = calls[2].body as FormData;
  assert.equal(upload.get("messaging_product"), "whatsapp");
  assert.equal((upload.get("file") as Blob).type, "image/png");
  assert.deepEqual(JSON.parse(String(calls[3].body)), {
    messaging_product: "whatsapp", to: "263770000000", type: "image", image: { id: "999", caption: "Photo 1 of 1" },
  });
  download = 404;
  await assert.rejects(sendWhatsApp("263770000000", image, true), /WhatsApp send failed \(media download, HTTP 404\)/);
  // Photos WhatsApp cannot send are refused before any upload.
  download = 200;
  for (const [lookup, error] of [[{ mime_type: "image/webp" }, /media type unsupported/], [{ mime_type: "image/png", file_size: 5 * 1024 * 1024 + 1 }, /media too large/]] as const) {
    calls.length = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET" });
      return Response.json({ url: "https://lookaside.example/555", ...lookup });
    });
    await assert.rejects(sendWhatsApp("263770000000", image, true), error);
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
  }
  calls.length = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    return url.endsWith("/555") && url.startsWith("https://lookaside")
      ? new Response(new Uint8Array(5 * 1024 * 1024 + 1)) : Response.json({ url: "https://lookaside.example/555", mime_type: "image/jpeg" });
  });
  await assert.rejects(sendWhatsApp("263770000000", image, true), /media too large/);
  assert.equal(calls.filter(({ method }) => method === "POST").length, 0);
});
