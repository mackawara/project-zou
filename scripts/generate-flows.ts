import { mkdir, rm, writeFile } from "node:fs/promises";
import { cargo, towns } from "../src/domain";

const input = (name: string, label: string, required = true, max = 80) => ({
  type: "TextInput", name, label, required, "max-chars": max,
});
const dropdown = (name: string, label: string, options: readonly string[], multi = false) => ({
  type: multi ? "CheckboxGroup" : "Dropdown", name, label, required: true,
  "data-source": options.map((value) => ({ id: value, title: value })),
});
const note = (text: string) => ({ type: "TextBody", text });
const date = { type: "DatePicker", name: "date", label: "Date", required: true };
const forms = {
  search: {
    title: "Find a truck", fields: [dropdown("pickup", "Pickup town", towns), dropdown("dropoff", "Drop-off town", towns),
      date, dropdown("cargo", "Cargo type", cargo), input("weight", "Weight (tonnes)", true, 4),
      { type: "TextArea", name: "notes", label: "Handling notes", required: false, "max-length": 200 }],
  },
  trip: {
    title: "Advertise space", fields: [dropdown("origin", "Origin", towns), dropdown("destination", "Destination", towns),
      date, { ...input("time", "Departure time", true, 5), "helper-text": "Use 24-hour time, e.g. 07:30" }, input("capacity", "Space (tonnes)", true, 4),
      dropdown("acceptedCargo", "Cargo you can carry", cargo, true)],
  },
  trucker: {
    title: "Trucker details", fields: [note("Zunde uses these details to operate the pilot and sends updates about your adverts. Your WhatsApp number is shared once a shipper accepts your offer."),
      input("name", "Full name"), input("nationalId", "National ID", true, 20),
      input("registration", "Truck registration", true, 20), input("company", "Company name", true, 100)],
  },
};

await mkdir("dist/whatsapp-flows", { recursive: true });
// Remove obsolete generated single-value forms from previous runs.
for (const key of ["shipper", "offer", "capacity"]) {
  await rm(`dist/whatsapp-flows/${key}.json`, { force: true });
}
for (const [key, { title, fields }] of Object.entries(forms)) {
  const payload = Object.fromEntries(fields.flatMap((field) => "name" in field ? [[field.name, "${form." + field.name + "}"]] : []));
  const definition = {
    version: "7.1",
    screens: [{
      id: "FORM", title, terminal: true, success: true,
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
