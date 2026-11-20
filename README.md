# Zunde pilot

Zunde matches shippers with spare truck capacity through WhatsApp. The Next.js server receives webhook events and serves one read-only analytics page. A separate Node.js worker handles messages and shipment changes using MongoDB.

## Pilot workflow

1. The shipper opens **Find a truck** and submits pickup, destination, ready date, cargo type and weight. No registration is needed to see results. Searches can be reopened from **My activity**.
2. The trucker uses **Advertise space** to submit a route, departure, available tonnes and cargo types. On the first advert, Zunde asks for name, national ID, truck registration and company name. Completing that form unlocks posting and receiving requests. Staff do not review documents in the pilot.
3. The matcher returns up to ten future departures that cover the route in the right direction, leave on the ready date or next two calendar days in Zimbabwe, accept the cargo, and list enough space. It sorts by departure. The initial corridor runs Harare → Kwekwe → Gweru → Bulawayo → Hwange → Victoria Falls and supports both directions.
4. The shipper selects one truck for the load. At the first selection, Zunde asks for the shipper's name and uses their WhatsApp number. The trucker can submit a total price in USD or decline. The shipper can switch trucks while waiting. An unanswered request expires after two hours or at departure, whichever is earlier. A quoted offer remains available until departure, withdrawal or acceptance.
5. Accepting an offer confirms the shipment and shares both phone numbers. The parties arrange payment directly. A truck can take multiple shipments. The trucker manages capacity through **Update space** and should update it after accepting a shipment or when plans change.
6. The trucker marks the shipment delivered and the shipper confirms receipt or forwards the receipt link to their receiver. A separate receiver confirms by messaging Zunde with the link. Both confirmations are required and either can arrive first. The trucker cannot use the receiver link from the number attached to the shipment. A confirmed shipment can be cancelled before either delivery confirmation. Zunde records who cancelled and when and shows cancelled shipments under **My activity**.

The admin dashboard has four sections in its side bar:

- **Dashboard home** counts shippers, truckers, open adverts and shipments, and lists what needs attention: confirmed shipments with no delivery confirmation two days after departure, deliveries confirmed by only one side, and incoming messages or replies that failed after six attempts. It also lists the last week's bookings and adverts.
- **Users** lists shippers who gave their name and registered truckers, with company, vehicle, advert and shipment counts and when they last messaged Zunde. It can be filtered by role and searched by name, number, company or vehicle. National ID numbers stay encrypted and are never shown.
- **Trips and bookings** lists open or all space adverts, transport requests with their booking status, and bookings. Each booking opens to show both parties, the departure and a timeline from request to delivery or cancellation.
- **Reports** shows searches, adverts, searches that found at least one match, accepted offers, completed deliveries and cancellations, plus route and daily activity. Completed deliveries and cancellations are counted by event date. Search counts omit personal details and remain available when an unbooked search expires.

Lists show the latest 100 entries.

Only multi-field steps use WhatsApp Flows: truck search, space advert and trucker registration. Shipper name, offer price and capacity updates use normal text replies with server validation. Invalid replies keep the same step open and explain the allowed input. Each reply step belongs to the sender, lasts one hour and is consumed after valid input. MENU, CANCEL or choosing another action leaves the step without changing the shipment or advert. Cancellation of a shipment still uses its **Cancel shipment** button.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open [the local dashboard](http://localhost:3000). Development without a database displays labelled sample data on every page. Copy `.env.example` to `.env.local` to connect a MongoDB replica set or Atlas cluster and serve actual pilot analytics. Every dashboard page requires the configured admin username and a password of at least 16 characters when connected to a database or running a production build.

## Connect WhatsApp

1. Generate the three Flow definitions with `npm run flows`: `search.json`, `trip.json` and `trucker.json` in `dist/whatsapp-flows/`. Import each into the pilot's WhatsApp Business Account, validate the forms in WhatsApp Manager, and publish them. Record each Flow ID in its matching `WA_FLOW_*` setting. The forms use the same town and cargo lists as the matcher. Shipper name, offer price and capacity updates need no Flow IDs.
2. Set the Meta app secret, phone number ID, access token, verify token and the Graph API version enabled for the app. Set `WA_BUSINESS_NUMBER` to the WhatsApp business number in international digits, with no plus sign, so recipients receive a tappable receipt link.
3. Serve the Next.js app over HTTPS and subscribe the Meta app to `messages` on `https://<your-host>/whatsapp/hook`. This endpoint handles both GET verification and incoming POST messages. Set `WA_PHONE_NUMBER_ID` to the receiving business phone number ID. Only messages whose `metadata.phone_number_id` exactly matches this ID are handled; messages for other numbers or without that metadata are acknowledged and ignored. Run `npm run worker` alongside it to retry messages or replies that failed in the webhook. The worker creates MongoDB indexes at startup. For self-hosting, run `npm run build` and `npm start`, and supervise the worker and web process with the server's process manager.
4. For notifications to people outside WhatsApp's customer-service window, configure an approved utility template with no variables, such as “You have a Zunde shipment update. Reply MENU and choose My activity.” Send it only to opted-in pilot participants. Without a configured template users can still retrieve updates from **My activity** when they message Zunde again.
5. Test with separate pilot WhatsApp numbers for a shipper, trucker and receiver. Use synthetic identity details until the test accounts and Flow configurations are verified.

The webhook checks `x-hub-signature-256` against an HMAC-SHA256 of the raw request body using `WA_APP_SECRET` before parsing or saving events. Missing, invalid or mismatched signatures return 401. It then handles only messages addressed to `WA_PHONE_NUMBER_ID`; both checks must pass before a message can be handled. Missing app secret or phone number ID returns 503. As in the ISP bot, the webhook handles each message before it responds: it skips message IDs it has already received, runs the conversation step, sends the replies and marks the message read. Handling errors are logged and still acknowledged with 200; the webhook returns 503 so Meta retries only when the inbox cannot be written. MongoDB transactions commit business changes, message processing and outgoing messages together. If handling or a send fails part-way, the worker retries it. Outside production, errors are logged in full: stack, cause and every property, including MongoDB and Graph API error responses. With `NODE_ENV=production`, set for `next start` and needed for the worker, only the error name and code are logged, because those messages can quote personal data. Keep the database key and credentials in the server environment. Back up the key securely alongside the database because it protects trucker IDs and signs receipt links.

## Checks

```sh
npm run check
npm test
npm run build
```

Set `TEST_MONGODB_URI` to a disposable replica set and run `npm test` to include the integration test. It uses an isolated test database, sends signed synthetic WhatsApp webhooks and captures outgoing messages locally.

See the [Next.js Route Handlers guide](https://nextjs.org/docs/app/getting-started/route-handlers), [Meta's published Flow API example](https://www.postman.com/meta/whatsapp-business-platform/request/56fec8h/send-published-flow-by-name) and [MongoDB driver transaction guide](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/).
