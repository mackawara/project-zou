import { randomUUID } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { collections, type Action, type Event, type FlowName, type FlowTicket, type Message, type PendingInput } from "./db";
import {
  capacityForm, checkForm, dateRange, dateWindow, day, dayOffset, dollars, findMatches, formatDeparture, hour, isActive,
  fixList, localDate, localMidnight, matchWindowDays, maxTonnes, offerForm, recordDelivery, requestForm, shipperForm, tripFits, tripForm, truckerForm,
  type Shipment, type TransportRequest, type Trip, type TripDetails,
} from "./domain";
import { guideButtons, guides, helpCommands, menu, overview, welcome, type Guide } from "./guide";
import { encryptId, receiptToken, sameSecret } from "./secrets";

export const actions = {
  search: { id: "search", title: "Find a truck" },
  trip: { id: "trip", title: "Advertise space" },
  activity: { id: "activity", title: "My activity" },
};
const help = { id: "help", title: "How it works" };
const menuAction = { id: "menu", title: "Main menu" };
const capacity = (kg: number) => `${kg / 1000} t`;
// The departure, flagged when it is not on the shipper's requested day.
const departureNote = (r: TransportRequest, trip: Trip) => {
  const offset = dayOffset(r.date, trip.departureAt);
  return `${formatDeparture(trip.departureAt)}${offset && ` · ${offset}`}`;
};
const loadDetails = (r: TransportRequest) => `${r.pickup} → ${r.dropoff} · ${capacity(r.weight)} of ${r.cargo} · ready ${r.date}`;
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

  private outboxItem(to: string, message: Message, matchShipper?: string) {
    return {
      _id: `${this.event.id}:${this.outgoing++}`, to, message, attempts: 0, nextAt: this.now,
      expiresAt: new Date(this.now.getTime() + 48 * hour), ...(matchShipper && { matchShipper }),
    };
  }

  private async send(to: string, message: Message) {
    await this.c.outbox.insertOne(this.outboxItem(to, message), this.options);
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
    // Date pickers only offer days a submission can use: today up to the booking window.
    const { min, max } = dateRange(this.now);
    const screen = flow === "trucker" ? undefined : { min_date: min, max_date: max };
    await this.send(this.from, { kind: "flow", body, flow, token, ...(screen && { screen }) });
  }

  private async prompt(input: PendingInput["input"], body: string, data: PendingInput["data"]) {
    await this.c.inputs.replaceOne({ _id: this.from }, {
      input, data, expiresAt: new Date(this.now.getTime() + hour),
    }, { ...this.options, upsert: true });
    return this.say(body + "\nReply MENU to leave this step.");
  }

  async handle() {
    const { kind, value, at } = this.event;
    const contact = await this.c.contacts.updateOne({ _id: this.from }, {
      $max: { lastIncomingAt: at, expiresAt: new Date(at.getTime() + 48 * hour) },
    }, { ...this.options, upsert: true });
    const text = value.trim();
    const command = text.toLowerCase();
    // Navigation replaces the current reply context so later text cannot edit an old load.
    const showHelp = kind === "text" && helpCommands.includes(command);
    if (kind !== "text" || showHelp || /^(menu|cancel|find a truck|advertise space|my activity)$/.test(command) || /^received /i.test(text)) {
      await this.c.inputs.deleteOne({ _id: this.from }, this.options);
    } else {
      const pending = await this.c.inputs.findOne({ _id: this.from }, this.options);
      if (pending) {
        if (pending.expiresAt <= this.now) {
          await this.c.inputs.deleteOne({ _id: this.from }, this.options);
          return this.choose("That reply step has expired. Open the item again from My activity.", [actions.activity]);
        }
        return this.submitInput(pending, text);
      }
    }
    if (kind === "flow") return this.submit(value);
    if (kind === "action") return this.click(value);
    if (/^received /i.test(text)) return this.receiveAsGuest(text.slice(9).trim());
    if (showHelp) return this.help();
    switch (command) {
      case "find a truck": return this.click("search");
      case "advertise space": return this.click("trip");
      case "my activity": return this.activity();
    }
    // Explain the service to people who have not used it yet: no profile and no recent messages.
    const newcomer = contact.upsertedCount > 0 && !await this.c.profiles.findOne({ _id: this.from }, this.options);
    return this.menu(newcomer);
  }

  private menu(newcomer = false) {
    return this.choose(newcomer ? welcome : menu, Object.values(actions));
  }

  private help(guide?: string) {
    if (guide && guide in guides) {
      const start = { shipper: [actions.search], trucker: [actions.trip], receiver: [] }[guide as Guide];
      return this.choose(guides[guide as Guide], [...start, help, menuAction]);
    }
    return this.choose(overview, guideButtons);
  }

  private async blockedShipper(phone: string, serialize = false) {
    const query = { _id: phone, shipper: { $exists: true } };
    // A write orders a new booking/search against an admin changing this role in another transaction.
    const profile = serialize
      ? await this.c.profiles.findOneAndUpdate(query, { $inc: { shipperRevision: 1 } }, this.options)
      : await this.c.profiles.findOne(query, this.options);
    return profile?.shipperAccess?.suspended === true;
  }

  private suspensionNotice() {
    return this.choose("Your shipper account is suspended. Contact Zunde about reinstatement. You can manage existing deliveries in My activity.", [actions.activity]);
  }

  private async submitInput(pending: PendingInput, value: string) {
    const { input, data } = pending;
    switch (input) {
      case "shipper": {
        if (await this.blockedShipper(this.from, true)) return this.suspensionNotice();
        const parsed = shipperForm.safeParse({ name: value });
        if (!parsed.success) return this.say("Enter your name in 1 to 80 characters, for example Tendai Moyo, or reply MENU to leave this step.");
        await this.c.inputs.deleteOne({ _id: this.from }, this.options);
        await this.c.profiles.updateOne({ _id: this.from }, { $set: { "shipper.name": parsed.data.name } }, { ...this.options, upsert: true });
        if (data.requestId && data.tripId) return this.select(data.requestId, data.tripId);
        return this.activity();
      }
      case "offer": {
        const parsed = offerForm.safeParse({ price: value });
        if (!parsed.success) return this.say("Enter the total price in US dollars using numbers only, for example 80 or 80.25 (no $ sign, up to two decimal places). Reply MENU to leave this step.");
        await this.c.inputs.deleteOne({ _id: this.from }, this.options);
        if (data.shipmentId) return this.postOffer(data.shipmentId, parsed.data.price);
        return this.activity();
      }
      case "capacity": {
        const parsed = capacityForm.safeParse({ capacity: value });
        if (!parsed.success) return this.say(`Enter the space as whole tonnes from 1 to ${maxTonnes}, for example 12 (decimals are not accepted), or 0 to hide this trip. Reply MENU to leave this step.`);
        await this.c.inputs.deleteOne({ _id: this.from }, this.options);
        const previous = await this.c.trips.findOneAndUpdate({
          _id: data.tripId, trucker: this.from, closedAt: { $exists: false }, departureAt: { $gt: this.now },
        }, { $set: { capacity: parsed.data.capacity } }, { ...this.options, returnDocument: "before" });
        if (!previous) return this.say("This advert is no longer active.");
        const body = `Advert updated. Available space: ${capacity(parsed.data.capacity)}.`;
        if (parsed.data.capacity <= previous.capacity) return this.say(body);
        return this.announceSpace({ ...previous, capacity: parsed.data.capacity }, body, previous.capacity);
      }
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
        if (await this.blockedShipper(this.from, true)) return this.suspensionNotice();
        const parsed = checkForm(requestForm, result, this.now, "load date");
        if (!parsed.ok) return this.flow("search", fixList(parsed.problems));
        const request = { ...parsed.data, _id: randomUUID(), shipper: this.from, createdAt: this.now, expiresAt: dateWindow(parsed.data.date).end };
        await this.c.requests.insertOne(request, this.options);
        const { _id, pickup, dropoff, createdAt } = request;
        await this.c.searchMetrics.insertOne({ _id, pickup, dropoff, createdAt }, this.options);
        await this.synchronizeMatching(localDate(dateWindow(request.date).start), 2 * matchWindowDays + 1);
        return this.showMatches(request, true);
      }
      case "trip": {
        const parsed = checkForm(tripForm, result, this.now, "departure date");
        if (!parsed.ok) return this.flow("trip", fixList(parsed.problems));
        if (this.departure(parsed.data) <= this.now) return this.flow("trip", this.departurePassed(parsed.data));
        const profile = await this.c.profiles.findOne({ _id: this.from }, this.options);
        if (profile?.trucker) return this.publish(parsed.data);
        return this.flow("trucker", "Add your details once to publish this advert.", { draftTrip: parsed.data });
      }
      case "trucker": {
        const parsed = checkForm(truckerForm, result, this.now);
        if (!parsed.ok) return this.flow("trucker", fixList(parsed.problems), data);
        const { nationalId, ...trucker } = parsed.data;
        await this.c.profiles.updateOne({ _id: this.from }, {
          $set: { trucker: { ...trucker, nationalIdEncrypted: encryptId(nationalId) } },
        }, { ...this.options, upsert: true });
        return data?.draftTrip ? this.publish(data.draftTrip) : this.activity();
      }
    }
  }

  private departure(trip: TripDetails) {
    return new Date(`${trip.date}T${trip.time}:00+02:00`);
  }

  private departurePassed(trip: TripDetails) {
    return fixList([`The departure ${formatDeparture(this.departure(trip))} has already passed. Enter a later time or choose another day.`]);
  }

  private async publish(draft: TripDetails) {
    const departureAt = this.departure(draft);
    if (departureAt <= this.now) return this.flow("trip", this.departurePassed(draft));
    const { date: _date, time: _time, ...details } = draft;
    const trip = { ...details, _id: randomUUID(), trucker: this.from, departureAt, createdAt: this.now };
    await this.c.trips.insertOne(trip, this.options);
    return this.announceSpace(trip, `Advert posted. ${trip.origin} to ${trip.destination}, ${formatDeparture(trip.departureAt)}, ${capacity(trip.capacity)} available.`);
  }

  // Concurrent search and advert transactions would otherwise both read snapshots
  // taken before the other's insert. Touch their shared departure day so MongoDB
  // retries one transaction and the second posting sees the first.
  private async synchronizeMatching(date: string, days: number) {
    const start = localMidnight(date).getTime();
    for (let i = 0; i < days; i++) {
      const midnight = new Date(start + i * day);
      await this.c.matchDays.updateOne({ _id: midnight }, {
        $inc: { revision: 1 }, $setOnInsert: { expiresAt: new Date(midnight.getTime() + day) },
      }, { ...this.options, upsert: true });
    }
  }

  private async matchingLoads(trip: Trip) {
    const requests = await this.c.requests.find({
      shipper: { $ne: trip.trucker }, cancelledAt: { $exists: false },
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: this.now } }],
      date: {
        $gte: localDate(new Date(trip.departureAt.getTime() - matchWindowDays * day)),
        $lte: localDate(new Date(trip.departureAt.getTime() + matchWindowDays * day)),
      },
      cargo: { $in: trip.acceptedCargo }, weight: { $lte: trip.capacity },
    }, this.options).sort({ date: 1, createdAt: 1, _id: 1 }).toArray();
    if (!requests.length) return [];
    const suspended = await this.c.profiles.find({
      _id: { $in: requests.map(r => r.shipper) }, "shipperAccess.suspended": true,
    }, { ...this.options, projection: { _id: 1 } }).toArray();
    const blocked = new Set(suspended.map(profile => profile._id));
    const fits = requests.filter((r) => !blocked.has(r.shipper) && tripFits(r, trip, this.now));
    const selections = fits.flatMap((r) => r.selectionId ? [r.selectionId] : []);
    if (!selections.length) return fits;
    const shipments = await this.c.shipments.find({ _id: { $in: selections } }, this.options).toArray();
    const occupied = new Set(shipments.filter((s) => isActive(s, this.now)).map((s) => s._id));
    return fits.filter((r) => !r.selectionId || !occupied.has(r.selectionId));
  }

  private async announceSpace(trip: Trip, body: string, previousCapacity = 0) {
    await this.synchronizeMatching(localDate(trip.departureAt), 1);
    const loads = await this.matchingLoads(trip);
    await this.manageTrip(trip, body, loads);
    const fresh = loads.filter((r) => r.weight > previousCapacity && !r.matchedTripIds?.includes(trip._id));
    if (!fresh.length) return;
    const ids = fresh.map((r) => r._id);
    await this.c.requests.updateMany({ _id: { $in: ids } }, { $addToSet: { matchedTripIds: trip._id } }, this.options);
    await this.c.searchMetrics.updateMany({ _id: { $in: ids }, matchedAt: { $exists: false } }, { $set: { matchedAt: this.now } }, this.options);
    const alerts = fresh.map((request) => this.outboxItem(request.shipper, {
      kind: "buttons",
      body: `A truck now fits your load.\n${loadDetails(request)}\nTruck from ${trip.origin} to ${trip.destination}, ${departureNote(request, trip)} · ${capacity(trip.capacity)} free.`,
      actions: [
        { id: `select:${request._id}:${trip._id}`, title: "Request a price" },
        { id: `results:${request._id}`, title: "See available trucks" },
      ],
    }, request.shipper));
    await this.c.outbox.insertMany(alerts, this.options);
  }

  private async showMatches(request: TransportRequest, newSearch = false) {
    const current = request.selectionId && await this.c.shipments.findOne({ _id: request.selectionId }, this.options);
    if (current && isActive(current, this.now)) return this.showShipment(current);
    if (await this.blockedShipper(request.shipper)) return this.suspensionNotice();
    if (request.cancelledAt || dateWindow(request.date).end <= this.now) return this.choose("This search has ended.", [actions.search]);
    const { start, end } = dateWindow(request.date);
    const trips = await this.c.trips.find({
      trucker: { $ne: request.shipper }, closedAt: { $exists: false },
      departureAt: { $gte: start, $gt: this.now, $lt: end }, capacity: { $gte: request.weight }, acceptedCargo: request.cargo,
    }, this.options).toArray();
    const matches = findMatches(request, trips, this.now);
    if (!matches.length) {
      return this.choose("No truck fits this load right now. We'll look for new space until this search ends. You can check again from My activity.", [
        { id: `results:${request._id}`, title: "Check again" }, actions.search,
      ]);
    }
    await this.c.searchMetrics.updateOne({ _id: request._id, matchedAt: { $exists: false } }, { $set: { matchedAt: this.now } }, this.options);
    await this.choose(`Available trucks for ${request.pickup} to ${request.dropoff}. Choose one to request a price.`, matches.map((trip, i) => ({
      id: `select:${request._id}:${trip._id}`, title: `Truck ${i + 1} · ${capacity(trip.capacity)} free`,
      description: `${trip.origin} → ${trip.destination} · ${departureNote(request, trip)}`,
    })));
    if (!newSearch) return;
    await this.c.requests.updateOne({ _id: request._id }, {
      $addToSet: { matchedTripIds: { $each: matches.map((trip) => trip._id) } },
    }, this.options);
    for (const trucker of new Set(matches.map((trip) => trip.trucker))) {
      await this.c.outbox.insertOne(this.outboxItem(trucker, { kind: "buttons",
        body: `A shipper is looking for space: ${loadDetails(request)}. You'll receive a price request if they select your truck.`,
        actions: [actions.activity],
      }, request.shipper), this.options);
    }
  }

  private async select(requestId: string, tripId: string) {
    if (await this.blockedShipper(this.from, true)) return this.suspensionNotice();
    const request = await this.c.requests.findOne({ _id: requestId, shipper: this.from, cancelledAt: { $exists: false } }, this.options);
    const trip = await this.c.trips.findOne({ _id: tripId, trucker: { $ne: this.from } }, this.options);
    if (!request) return this.choose("This search has ended.", [actions.search]);
    const current = request.selectionId && await this.c.shipments.findOne({ _id: request.selectionId }, this.options);
    if (current && isActive(current, this.now)) return this.showShipment(current);
    if (!trip || !tripFits(request, trip, this.now)) return this.showMatches(request);
    const profile = await this.c.profiles.findOne({ _id: this.from }, this.options);
    if (!profile?.shipper) return this.prompt("shipper", "Reply with your name to request an offer. Zunde uses your name and WhatsApp number to arrange your shipment and send updates. Your number is shared with the trucker once you accept their offer.", { requestId, tripId });
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
    if (!trip || !request || !tripFits(request, trip, this.now)) return this.say("Your advert no longer fits this load. Check the advertised space.");
    if (await this.blockedShipper(shipment.shipper, true)) return this.say("This shipper is currently unable to receive offers.");
    const changes = { state: "offered", priceCents, offeredAt: this.now, replyBy: trip.departureAt } as const;
    await this.c.shipments.updateOne({ _id: id }, { $set: changes }, this.options);
    await this.say(`Offer sent for shipment ${reference(shipment)}.`);
    return this.showShipment({ ...shipment, ...changes }, shipment.shipper);
  }

  private async accept(shipment: Shipment) {
    if (shipment.shipper !== this.from || shipment.state !== "offered" || !isActive(shipment, this.now)) {
      return this.showShipment(shipment);
    }
    if (await this.blockedShipper(this.from, true)) return this.suspensionNotice();
    const request = await this.c.requests.findOne({ _id: shipment.requestId, selectionId: shipment._id }, this.options);
    const trip = await this.c.trips.findOne({ _id: shipment.tripId }, this.options);
    if (!trip || !request || !tripFits(request, trip, this.now)) {
      await this.c.shipments.updateOne({ _id: shipment._id }, { $set: { state: "declined", declinedAt: this.now } }, this.options);
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
      : { state, declinedAt: this.now, declinedBy: this.from };
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
    const shareReceipt = shipper && !shipment.receivedAt;
    if (shareReceipt) buttons.push(action("received", "Confirm receipt"));
    if (!shipper && !shipment.deliveredAt) buttons.push(action("delivered", "Mark delivered"));
    if (!shipment.deliveredAt && !shipment.receivedAt) buttons.push(cancel);
    if (!shipper) buttons.push({ id: `capacity:${shipment.tripId}`, title: "Update space" });
    if (buttons.length) await this.choose(body, buttons, to);
    else await this.say(body + "\nWaiting for the other party to confirm.", to);
    if (shareReceipt) {
      // Sent after the summary so the share button is the last thing the shipper sees.
      await this.send(to, {
        kind: "receipt", command: `received ${receiptToken(shipment._id)}`,
        body: `Is someone else receiving the goods for ${ref}? Tap Share with receiver and send the message to them. After delivery they tap the link inside and press send to confirm.\nIf you receive the goods yourself, tap Confirm receipt above instead.`,
        share: `Zunde delivery ${ref}: ${load}.\nWhen the goods reach you, tap this link and press send in WhatsApp to confirm you received them:`,
      });
    }
  }

  private manageTrip(trip: Trip, body: string, loads: TransportRequest[]) {
    if (trip.closedAt || trip.departureAt <= this.now) return this.say("This advert has ended.");
    const preview = loads.slice(0, 3).map(loadDetails);
    if (loads.length > preview.length) preview.push(`and ${loads.length - preview.length} more`);
    const summary = loads.length
      ? `${loads.length} matching ${loads.length === 1 ? "load" : "loads"}:\n${preview.join("\n")}\nYou'll receive a price request if a shipper selects your truck.`
      : "No open load matches this advert yet.";
    return this.choose(body + "\n" + summary, [{ id: `capacity:${trip._id}`, title: "Update space" }, { id: `close:${trip._id}`, title: "Close advert" }]);
  }

  private async activity() {
    const requests = await this.c.requests.find({ shipper: this.from, cancelledAt: { $exists: false } }, this.options).sort({ createdAt: -1 }).limit(10).toArray();
    const trips = await this.c.trips.find({ trucker: this.from, closedAt: { $exists: false }, departureAt: { $gt: this.now } }, this.options)
      .sort({ departureAt: 1 }).limit(10).toArray();
    const shipments = await this.c.shipments.find({ $or: [{ trucker: this.from }, { shipper: this.from }] }, this.options)
      .sort({ createdAt: -1 }).limit(10).toArray();
    if (!requests.length && !trips.length && !shipments.length) return this.choose("Your searches and adverts will appear here.", [actions.search, actions.trip, help]);
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
      case "search": return await this.blockedShipper(this.from) ? this.suspensionNotice() : this.flow("search", "Tell us what you need to move. Submit your search to see trucks and receive WhatsApp updates when space becomes available for this load.");
      case "trip": return this.flow("trip", "List the spare space on your planned trip.");
      case "activity": return this.activity();
      case "menu": return this.menu();
      case "help": return this.help(id);
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
        if (command === "capacity") return this.prompt("capacity", `Reply with the space still available for ${trip.origin} to ${trip.destination}, ${formatDeparture(trip.departureAt)}, in whole tonnes (e.g. 12). Enter 0 to hide this trip from search results.`, { tripId: id });
        if (command === "close") {
          await this.c.trips.updateOne({ _id: id }, { $set: { closedAt: this.now } }, this.options);
          return this.say("Advert closed. Confirmed shipments remain in My activity.");
        }
        return this.manageTrip(trip, `${trip.origin} to ${trip.destination} · ${formatDeparture(trip.departureAt)} · ${capacity(trip.capacity)} free`, await this.matchingLoads(trip));
      }
    }
    const shipment = id && await this.getShipment(id);
    if (!shipment) return this.choose("That option is no longer available.", [actions.activity]);
    const shipper = shipment.shipper === this.from;
    switch (command) {
      case "shipment": return this.showShipment(shipment);
      case "offer":
        if (!shipper && shipment.state === "requested" && isActive(shipment, this.now)) {
          return this.prompt("offer", `Reply with your total price in USD for shipment ${reference(shipment)} (numbers only, e.g. 80 or 80.25). Send the offer only if you have space.`, { shipmentId: id });
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
