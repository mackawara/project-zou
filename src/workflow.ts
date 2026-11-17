import { randomUUID } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { collections, type Action, type Event, type FlowName, type FlowTicket, type Message } from "./db";
import {
  capacityForm, dateAllowed, dateWindow, dollars, findMatches, formatDeparture, hour, isActive,
  offerForm, recordDelivery, requestForm, shipperForm, tripForm, truckerForm,
  type Shipment, type TransportRequest, type Trip, type TripDetails,
} from "./domain";
import { encryptId, receiptToken, sameSecret } from "./secrets";

export const actions = {
  search: { id: "search", title: "Find a truck" },
  trip: { id: "trip", title: "Advertise space" },
  activity: { id: "activity", title: "My activity" },
};
const capacity = (kg: number) => `${kg / 1000} t`;
const reference = (shipment: Shipment) => shipment._id.slice(0, 8).toUpperCase();

export class Workflow {
  private readonly c;
  private readonly options;
  private readonly now;
  private readonly from;
  private outgoing = 0;

  constructor(db: Db, session: ClientSession, private readonly event: Event, now = new Date()) {
    this.c = collections(db);
    this.options = { session };
    this.now = now;
    this.from = event.from;
  }

  private async send(to: string, message: Message) {
    await this.c.outbox.insertOne({
      _id: `${this.event.id}:${this.outgoing++}`, to, message, attempts: 0, nextAt: this.now,
      expiresAt: new Date(this.now.getTime() + 48 * hour),
    }, this.options);
  }

  private say(body: string, to = this.from) {
    return this.send(to, { kind: "text", body });
  }

  private choose(body: string, buttons: Action[], to = this.from) {
    return this.send(to, { kind: buttons.length > 3 || buttons.some((button) => button.description) ? "list" : "buttons", body, actions: buttons });
  }

  private async flow(flow: FlowName, body: string, data?: FlowTicket["data"]) {
    const token = randomUUID();
    await this.c.tickets.insertOne({
      _id: token, owner: this.from, flow, data, expiresAt: new Date(this.now.getTime() + hour),
    }, this.options);
    await this.send(this.from, { kind: "flow", body, flow, token });
  }

  async handle() {
    const { kind, value, at } = this.event;
    await this.c.contacts.updateOne({ _id: this.from }, {
      $max: { lastIncomingAt: at, expiresAt: new Date(at.getTime() + 48 * hour) },
    }, { ...this.options, upsert: true });
    if (kind === "flow") return this.submit(value);
    if (kind === "action") return this.click(value);
    if (/^received /i.test(value)) return this.receiveAsGuest(value.slice(9).trim());
    switch (value.trim().toLowerCase()) {
      case "find a truck": return this.click("search");
      case "advertise space": return this.click("trip");
      case "my activity": return this.activity();
      default: return this.choose("Welcome to Zunde. What would you like to do?", Object.values(actions));
    }
  }

  private async submit(raw: string) {
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(raw);
    } catch {
      return this.say("This form could not be read. Reply MENU to try again.");
    }
    if (!result || typeof result.flow_token !== "string") return this.say("This form could not be read. Reply MENU to try again.");
    const ticket = await this.c.tickets.findOneAndDelete({
      _id: result.flow_token, owner: this.from, expiresAt: { $gt: this.now },
    }, this.options);
    if (!ticket) return this.choose("This form has already been used or has expired.", [actions.activity]);
    const data = ticket.data;
    switch (ticket.flow) {
      case "search": {
        const parsed = requestForm.safeParse(result);
        if (!parsed.success || !dateAllowed(parsed.data.date, this.now)) {
          return this.flow("search", "Choose different towns, a date within 30 days, and a weight from 0.1 to 40 tonnes.");
        }
        const request = { ...parsed.data, _id: randomUUID(), shipper: this.from, createdAt: this.now, expiresAt: dateWindow(parsed.data.date).end };
        await this.c.requests.insertOne(request, this.options);
        const { _id, pickup, dropoff, createdAt } = request;
        await this.c.searchMetrics.insertOne({ _id, pickup, dropoff, createdAt }, this.options);
        return this.showMatches(request);
      }
      case "trip": {
        const parsed = tripForm.safeParse(result);
        if (!parsed.success || !dateAllowed(parsed.data.date, this.now) || this.departure(parsed.data) <= this.now) {
          return this.flow("trip", "Choose different towns, a future departure within 30 days, and space from 0.1 to 40 tonnes.");
        }
        const profile = await this.c.profiles.findOne({ _id: this.from }, this.options);
        if (profile?.trucker) return this.publish(parsed.data);
        return this.flow("trucker", "Add your details once to publish this advert.", { draftTrip: parsed.data });
      }
      case "shipper": {
        const parsed = shipperForm.safeParse(result);
        if (!parsed.success) return this.flow("shipper", "Enter your full name to continue.", data);
        await this.c.profiles.updateOne({ _id: this.from }, { $set: { shipper: parsed.data } }, { ...this.options, upsert: true });
        if (data?.requestId && data.tripId) return this.select(data.requestId, data.tripId);
        return this.activity();
      }
      case "trucker": {
        const parsed = truckerForm.safeParse(result);
        if (!parsed.success) return this.flow("trucker", "Check your details. Enter your ID in the format 63-1234567-F-42.", data);
        const { nationalId, ...trucker } = parsed.data;
        await this.c.profiles.updateOne({ _id: this.from }, {
          $set: { trucker: { ...trucker, nationalIdEncrypted: encryptId(nationalId) } },
        }, { ...this.options, upsert: true });
        return data?.draftTrip ? this.publish(data.draftTrip) : this.activity();
      }
      case "offer": {
        const parsed = offerForm.safeParse(result);
        if (!parsed.success) return this.flow("offer", "Enter the total price in USD, for example 80.00.", data);
        if (data?.shipmentId) return this.postOffer(data.shipmentId, parsed.data.price);
        return this.activity();
      }
      case "capacity": {
        const parsed = capacityForm.safeParse(result);
        if (!parsed.success) return this.flow("capacity", "Enter 0 or a number from 0.1 to 40 tonnes.", data);
        const updated = await this.c.trips.updateOne({
          _id: data?.tripId, trucker: this.from, closedAt: { $exists: false }, departureAt: { $gt: this.now },
        }, { $set: { capacity: parsed.data.capacity } }, this.options);
        return this.say(updated.matchedCount ? `Advert updated. Available space: ${capacity(parsed.data.capacity)}.` : "This advert is no longer active.");
      }
    }
  }

  private departure(trip: TripDetails) {
    return new Date(`${trip.date}T${trip.time}:00+02:00`);
  }

  private async publish(draft: TripDetails) {
    const departureAt = this.departure(draft);
    if (departureAt <= this.now) return this.flow("trip", "That departure has passed. Enter a new departure time.");
    const { date: _date, time: _time, ...details } = draft;
    const trip = { ...details, _id: randomUUID(), trucker: this.from, departureAt, createdAt: this.now };
    await this.c.trips.insertOne(trip, this.options);
    return this.manageTrip(trip, `Advert posted. ${trip.origin} to ${trip.destination}, ${formatDeparture(trip.departureAt)}, ${capacity(trip.capacity)} available.`);
  }

  private async showMatches(request: TransportRequest) {
    const current = request.selectionId && await this.c.shipments.findOne({ _id: request.selectionId }, this.options);
    if (current && isActive(current, this.now)) return this.showShipment(current);
    if (request.cancelledAt || dateWindow(request.date).end <= this.now) return this.choose("This search has ended.", [actions.search]);
    const { start, end } = dateWindow(request.date);
    const trips = await this.c.trips.find({
      trucker: { $ne: this.from }, closedAt: { $exists: false },
      departureAt: { $gte: start, $gt: this.now, $lt: end }, capacity: { $gte: request.weight }, acceptedCargo: request.cargo,
    }, this.options).toArray();
    const matches = findMatches(request, trips, this.now);
    if (!matches.length) {
      return this.choose("No truck fits this load right now. Check again from My activity.", [
        { id: `results:${request._id}`, title: "Check again" }, actions.search,
      ]);
    }
    await this.c.searchMetrics.updateOne({ _id: request._id, matchedAt: { $exists: false } }, { $set: { matchedAt: this.now } }, this.options);
    return this.choose(`Available trucks for ${request.pickup} to ${request.dropoff}. Choose one to request a price.`, matches.map((trip, i) => ({
      id: `select:${request._id}:${trip._id}`, title: `Truck ${i + 1} · ${capacity(trip.capacity)} free`,
      description: `${trip.origin} → ${trip.destination} · ${formatDeparture(trip.departureAt)}`,
    })));
  }

  private async select(requestId: string, tripId: string) {
    const request = await this.c.requests.findOne({ _id: requestId, shipper: this.from, cancelledAt: { $exists: false } }, this.options);
    const trip = await this.c.trips.findOne({ _id: tripId, trucker: { $ne: this.from } }, this.options);
    if (!request) return this.choose("This search has ended.", [actions.search]);
    const current = request.selectionId && await this.c.shipments.findOne({ _id: request.selectionId }, this.options);
    if (current && isActive(current, this.now)) return this.showShipment(current);
    if (!trip || !findMatches(request, [trip], this.now).length) return this.showMatches(request);
    const profile = await this.c.profiles.findOne({ _id: this.from }, this.options);
    if (!profile?.shipper) return this.flow("shipper", "Add your name to request an offer. Your WhatsApp number is captured automatically.", { requestId, tripId });
    const shipment: Shipment = {
      _id: randomUUID(), requestId, tripId, shipper: this.from, trucker: trip.trucker, createdAt: this.now,
      replyBy: new Date(Math.min(this.now.getTime() + 2 * hour, trip.departureAt.getTime())), state: "requested",
    };
    await this.c.shipments.insertOne(shipment, this.options);
    await this.c.requests.updateOne({ _id: requestId }, {
      $set: { selectionId: shipment._id }, $unset: { expiresAt: "" },
    }, this.options);
    await this.showShipment(shipment);
    return this.showShipment(shipment, trip.trucker);
  }

  private async getShipment(id: string) {
    return this.c.shipments.findOne({ _id: id, $or: [{ shipper: this.from }, { trucker: this.from }] }, this.options);
  }

  private async postOffer(id: string, priceCents: number) {
    const shipment = await this.getShipment(id);
    if (!shipment || shipment.trucker !== this.from || shipment.state !== "requested" || !isActive(shipment, this.now)) {
      return this.say("This request is no longer open.");
    }
    const trip = await this.c.trips.findOne({ _id: shipment.tripId }, this.options);
    const request = await this.c.requests.findOne({ _id: shipment.requestId }, this.options);
    if (!trip || !request || !findMatches(request, [trip], this.now).length) return this.say("Your advert no longer fits this load. Check the advertised space.");
    const changes = { state: "offered", priceCents, replyBy: trip.departureAt } as const;
    await this.c.shipments.updateOne({ _id: id }, { $set: changes }, this.options);
    await this.say(`Offer sent for shipment ${reference(shipment)}.`);
    return this.showShipment({ ...shipment, ...changes }, shipment.shipper);
  }

  private async accept(shipment: Shipment) {
    if (shipment.shipper !== this.from || shipment.state !== "offered" || !isActive(shipment, this.now)) {
      return this.showShipment(shipment);
    }
    const request = await this.c.requests.findOne({ _id: shipment.requestId, selectionId: shipment._id }, this.options);
    const trip = await this.c.trips.findOne({ _id: shipment.tripId }, this.options);
    if (!trip || !request || !findMatches(request, [trip], this.now).length) {
      await this.c.shipments.updateOne({ _id: shipment._id }, { $set: { state: "declined" } }, this.options);
      return this.choose("That truck is no longer available for this load.", [{ id: `results:${shipment.requestId}`, title: "Find another truck" }]);
    }
    // Serialize acceptance with trucker edits to this advert. Capacity stays trucker-managed.
    await this.c.trips.updateOne({ _id: trip._id }, { $set: { lastAcceptedAt: this.now } }, this.options);
    const confirmed = { ...shipment, state: "confirmed", confirmedAt: this.now } as const;
    await this.c.shipments.updateOne({ _id: shipment._id }, { $set: { state: confirmed.state, confirmedAt: this.now } }, this.options);
    await this.showShipment(confirmed);
    return this.showShipment(confirmed, shipment.trucker);
  }

  private closeSelection(shipment: Shipment, state: "cancelled" | "declined") {
    const changes = state === "cancelled"
      ? { state, cancelledAt: this.now, cancelledBy: this.from }
      : { state };
    return this.c.shipments.updateOne({ _id: shipment._id }, { $set: changes }, this.options);
  }

  private async receiveAsGuest(token: string) {
    const [id] = token.split(".");
    if (!/^[0-9a-f-]{36}$/.test(id) || !sameSecret(receiptToken(id), token)) {
      return this.say("This delivery confirmation link is invalid.");
    }
    const shipment = await this.c.shipments.findOne({ _id: id }, this.options);
    if (!shipment || shipment.trucker === this.from || !["confirmed", "completed"].includes(shipment.state)) {
      return this.say("This delivery cannot be confirmed from this number.");
    }
    return this.confirmDelivery(shipment, "receiver");
  }

  private async confirmDelivery(shipment: Shipment, role: "trucker" | "receiver") {
    if (shipment.state === "completed") return this.say("This shipment is already complete.");
    const updates = recordDelivery(shipment, role, this.now);
    if (!Object.keys(updates).length) return this.say("This shipment is not awaiting delivery confirmation.");
    await this.c.shipments.updateOne({ _id: shipment._id }, { $set: updates }, this.options);
    if (updates.state !== "completed") {
      const pending = role === "trucker" ? "the receiver" : "the trucker";
      return this.say(`Confirmation recorded for ${reference(shipment)}. Waiting for ${pending}.`);
    }
    const message = `Shipment ${reference(shipment)} is complete. Both delivery confirmations have been received.`;
    for (const person of new Set([this.from, shipment.shipper, shipment.trucker])) await this.say(message, person);
  }

  private async showShipment(shipment: Shipment, to = this.from) {
    const ref = reference(shipment);
    const action = (command: string, title: string) => ({ id: `${command}:${shipment._id}`, title });
    const cancel = action("cancel", "Cancel shipment");
    const shipper = to === shipment.shipper;
    if (shipment.state === "completed") return this.say(`Shipment ${ref} is complete.`, to);
    if (!isActive(shipment, this.now)) {
      const body = shipment.state === "declined" || shipment.state === "cancelled"
        ? `Shipment ${ref} was ${shipment.state}.` : `The offer request for ${ref} has expired.`;
      return shipper ? this.choose(body, [{ id: `results:${shipment.requestId}`, title: "Find another truck" }], to) : this.say(body, to);
    }
    const request = await this.c.requests.findOne({ _id: shipment.requestId }, this.options);
    if (!request) return this.say("This shipment could not be found.", to);
    const load = `${request.pickup} → ${request.dropoff} · ${capacity(request.weight)} of ${request.cargo}`;
    if (shipment.state === "requested") {
      return shipper
        ? this.choose(`Shipment ${ref} · ${load}\nWaiting for the trucker's offer.`, [action("withdraw", "Choose another"), actions.activity], to)
        : this.choose(`New shipment request ${ref} · ${load}\nReady from ${request.date}.\nSend an offer if you have space.`,
          [action("offer", "Make an offer"), action("decline", "Decline")], to);
    }
    const amount = dollars(shipment.priceCents!);
    if (shipment.state === "offered") {
      return shipper
        ? this.choose(`Offer for ${ref} · ${load}\nTotal: ${amount}. Accept to confirm the shipment and share contact numbers. Arrange payment directly with the trucker.`,
          [action("accept", "Accept offer"), action("withdraw", "Choose another")], to)
        : this.choose(`Offer of ${amount} sent for ${ref}.`, [action("decline", "Withdraw offer")], to);
    }
    const trip = await this.c.trips.findOne({ _id: shipment.tripId }, this.options);
    const contact = shipper ? shipment.trucker : shipment.shipper;
    let body = `Confirmed · ${ref}\n${load}\n${trip ? "Departure: " + formatDeparture(trip.departureAt) + "\n" : ""}Agreed price: ${amount}\n${shipper ? "Trucker" : "Shipper"}: +${contact}`;
    if (!shipper && request.notes) body += "\nHandling: " + request.notes;
    const buttons = [];
    if (shipper && !shipment.receivedAt) {
      const token = receiptToken(shipment._id);
      const business = process.env.WA_BUSINESS_NUMBER;
      const command = `received ${token}`;
      body += business
        ? `\nIf someone else receives the goods, forward this link for them to use after delivery:\nhttps://wa.me/${business}?text=${encodeURIComponent(command)}`
        : `\nIf someone else receives the goods, ask them to send this to Zunde after delivery:\n${command}`;
      buttons.push(action("received", "Confirm receipt"));
    }
    if (!shipper && !shipment.deliveredAt) buttons.push(action("delivered", "Mark delivered"));
    if (!shipment.deliveredAt && !shipment.receivedAt) buttons.push(cancel);
    if (!shipper) buttons.push({ id: `capacity:${shipment.tripId}`, title: "Update space" });
    return buttons.length ? this.choose(body, buttons, to) : this.say(body + "\nWaiting for the other party to confirm.", to);
  }

  private manageTrip(trip: Trip, body: string) {
    if (trip.closedAt || trip.departureAt <= this.now) return this.say("This advert has ended.");
    return this.choose(body, [{ id: `capacity:${trip._id}`, title: "Update space" }, { id: `close:${trip._id}`, title: "Close advert" }]);
  }

  private async activity() {
    const requests = await this.c.requests.find({ shipper: this.from, cancelledAt: { $exists: false } }, this.options).sort({ createdAt: -1 }).limit(10).toArray();
    const trips = await this.c.trips.find({ trucker: this.from, closedAt: { $exists: false }, departureAt: { $gt: this.now } }, this.options)
      .sort({ departureAt: 1 }).limit(10).toArray();
    const shipments = await this.c.shipments.find({ $or: [{ trucker: this.from }, { shipper: this.from }] }, this.options)
      .sort({ createdAt: -1 }).limit(10).toArray();
    if (!requests.length && !trips.length && !shipments.length) return this.choose("Your searches and adverts will appear here.", [actions.search, actions.trip]);
    const entries: Action[] = [
      ...requests.map((r) => ({ id: `results:${r._id}`, title: "Search · " + r.date, description: `${r.pickup} → ${r.dropoff}` })),
      ...shipments.map((s) => ({ id: `shipment:${s._id}`, title: `Shipment ${reference(s)}`, description: isActive(s, this.now) ? s.state : "Closed or expired" })),
      ...trips.map((t) => ({ id: `manage:${t._id}`, title: "Advert · " + capacity(t.capacity), description: `${t.origin} → ${t.destination} · ${formatDeparture(t.departureAt)}` })),
    ];
    const categories = new Set(entries.map((item) => item.id.split(":")[0]));
    if (categories.size > 1) {
      for (const [prefix, title] of [["results", "Your truck searches"], ["shipment", "Your shipment requests"], ["manage", "Your space adverts"]]) {
        const group = entries.filter((item) => item.id.startsWith(prefix + ":"));
        if (group.length) await this.choose(title, group);
      }
      return;
    }
    return this.choose("Your recent activity", entries);
  }

  private async click(value: string) {
    const [command, id, tripId] = value.split(":");
    switch (command) {
      case "search": return this.flow("search", "Tell us what you need to move. You can search without registering.");
      case "trip": return this.flow("trip", "List the spare space on your planned trip.");
      case "activity": return this.activity();
      case "results": {
        const request = await this.c.requests.findOne({ _id: id, shipper: this.from }, this.options);
        return request ? this.showMatches(request) : this.choose("This search has ended.", [actions.search]);
      }
      case "select": return this.select(id, tripId);
      case "manage":
      case "capacity":
      case "close": {
        const trip = await this.c.trips.findOne({ _id: id, trucker: this.from }, this.options);
        if (!trip || trip.closedAt || trip.departureAt <= this.now) return this.say("This advert is no longer active.");
        if (command === "capacity") return this.flow("capacity", "Enter the space still available for future shipments.", { tripId: id });
        if (command === "close") {
          await this.c.trips.updateOne({ _id: id }, { $set: { closedAt: this.now } }, this.options);
          return this.say("Advert closed. Confirmed shipments remain in My activity.");
        }
        return this.manageTrip(trip, `${trip.origin} to ${trip.destination} · ${formatDeparture(trip.departureAt)} · ${capacity(trip.capacity)} free`);
      }
    }
    const shipment = id && await this.getShipment(id);
    if (!shipment) return this.choose("That option is no longer available.", [actions.activity]);
    const shipper = shipment.shipper === this.from;
    switch (command) {
      case "shipment": return this.showShipment(shipment);
      case "offer":
        if (!shipper && shipment.state === "requested" && isActive(shipment, this.now)) {
          return this.flow("offer", "Enter a total price for this load. Send the offer only if you have space.", { shipmentId: id });
        }
        break;
      case "accept": if (shipper) return this.accept(shipment); break;
      case "decline":
      case "withdraw":
        if (shipper === (command === "withdraw") && ["requested", "offered"].includes(shipment.state) && isActive(shipment, this.now)) {
          await this.closeSelection(shipment, "declined");
          await this.say(`The offer request for ${reference(shipment)} is closed.`, shipper ? shipment.trucker : shipment.shipper);
          if (shipper) {
            const request = await this.c.requests.findOne({ _id: shipment.requestId }, this.options);
            if (request) return this.showMatches(request);
          }
          return this.say("The offer request is closed.");
        }
        break;
      case "cancel":
        if (shipment.state === "confirmed" && !shipment.deliveredAt && !shipment.receivedAt) {
          await this.closeSelection(shipment, "cancelled");
          await this.showShipment({ ...shipment, state: "cancelled" }, shipper ? shipment.trucker : shipment.shipper);
          return this.showShipment({ ...shipment, state: "cancelled" });
        }
        break;
      case "delivered": if (!shipper) return this.confirmDelivery(shipment, "trucker"); break;
      case "received": if (shipper) return this.confirmDelivery(shipment, "receiver"); break;
    }
    return this.showShipment(shipment);
  }
}
