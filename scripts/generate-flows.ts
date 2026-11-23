import { mkdir, rm, writeFile } from "node:fs/promises";
import { bookingWindowDays, cargo, maxTonnes, towns } from "../src/domain";

// Flow `pattern` (v6.2+) blocks a bad value inside WhatsApp before it is submitted,
// and `helper-text` (required with a pattern) doubles as the example shown under the field.
// The server repeats every check in src/domain.ts and replies with a specific fix.
type Input = { required?: boolean; max?: number; helper: string; pattern?: string; type?: "text" | "number" };
const input = (name: string, label: string, { required = true, max = 80, helper, pattern, type = "text" }: Input) => ({
  type: "TextInput", name, label, required, "input-type": type, "max-chars": max, "helper-text": helper,
  ...(pattern && { pattern }),
});
const dropdown = (name: string, label: string, options: readonly string[]) => ({
  type: "Dropdown", name, label, required: true, "data-source": options.map((value) => ({ id: value, title: value })),
});
const checkboxes = (name: string, label: string, options: readonly string[], description: string) => ({
  type: "CheckboxGroup", name, label, description, required: true, "min-selected-items": 1,
  "data-source": options.map((value) => ({ id: value, title: value })),
});
const note = (text: string) => ({ type: "TextBody", text });
// The calendar greys out days outside the window; the bounds arrive with each Flow message.
const date = (label: string, helper: string) => ({
  type: "DatePicker", name: "date", label, required: true, "helper-text": helper,
  "min-date": "${data.min_date}", "max-date": "${data.max_date}",
});
const dateData = {
  min_date: { type: "string", __example__: "2026-01-01" },
  max_date: { type: "string", __example__: "2026-01-31" },
};
const wholeTonnes = "^([1-9]|[1-3][0-9]|40)$";
if (maxTonnes !== 40) throw new Error("Update the whole-tonnes pattern to match maxTonnes");
const ahead = `Today up to ${bookingWindowDays} days ahead`;
const forms = {
  search: {
    title: "Find a truck", data: dateData, fields: [
      note("Pickup and drop-off must be different towns."),
      dropdown("pickup", "Pickup town", towns), dropdown("dropoff", "Drop-off town", towns),
      date("Date load is ready", ahead), dropdown("cargo", "Cargo type", cargo),
      input("weight", "Weight (tonnes)", { max: 2, type: "number", pattern: wholeTonnes, helper: `Whole tonnes from 1 to ${maxTonnes}, e.g. 12` }),
      { type: "TextArea", name: "notes", label: "Handling notes", required: false, "max-length": 200, "helper-text": "Optional, e.g. Keep dry, fragile, needs a tarpaulin" }],
  },
  trip: {
    title: "Advertise space", data: dateData, fields: [
      note("Origin and destination must be different towns."),
      dropdown("origin", "Origin", towns), dropdown("destination", "Destination", towns),
      date("Departure date", ahead),
      input("time", "Departure time", { max: 5, pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$", helper: "24-hour time with a colon, e.g. 07:30 or 16:45" }),
      input("capacity", "Space (tonnes)", { max: 2, type: "number", pattern: wholeTonnes, helper: `Whole tonnes of free space, 1 to ${maxTonnes}, e.g. 12` }),
      checkboxes("acceptedCargo", "Cargo you can carry", cargo, "Tick every cargo type you accept")],
  },
  trucker: {
    title: "Trucker details", data: undefined, fields: [note("Zunde uses these details to operate the pilot and sends updates about your adverts. Your WhatsApp number is shared once a shipper accepts your offer."),
      input("name", "Full name", { helper: "As on your ID, e.g. Tendai Moyo" }),
      input("nationalId", "National ID", { max: 20, pattern: "^[0-9]{2}[ -]?[0-9]{6,7}[ -]?[A-Za-z][ -]?[0-9]{2}$", helper: "e.g. 63-1234567-F-42" }),
      input("registration", "Truck registration", { max: 20, pattern: "^[A-Za-z0-9 -]+$", helper: "Number plate, e.g. ABC 1234" }),
      input("company", "Company name", { max: 100, helper: "e.g. Moyo Haulage" })],
  },
};

await mkdir("dist/whatsapp-flows", { recursive: true });
// Remove obsolete generated single-value forms from previous runs.
for (const key of ["shipper", "offer", "capacity"]) {
  await rm(`dist/whatsapp-flows/${key}.json`, { force: true });
}
for (const [key, { title, data, fields }] of Object.entries(forms)) {
  const payload = Object.fromEntries(fields.flatMap((field) => "name" in field ? [[field.name, "${form." + field.name + "}"]] : []));
  const definition = {
    version: "7.1",
    screens: [{
      id: "FORM", title, terminal: true, success: true, ...(data && { data }),
      layout: {
        type: "SingleColumnLayout", children: [{
          type: "Form", name: "details", children: [...fields, {
            type: "Footer", label: key === "search" ? "Find trucks" : "Submit",
            "on-click-action": { name: "complete", payload },
          }],
        }],
      },
    }],
  };
  await writeFile(`dist/whatsapp-flows/${key}.json`, JSON.stringify(definition, null, 2) + "\n");
}
