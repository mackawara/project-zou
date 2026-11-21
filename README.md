# Zunde pilot

Zunde matches shippers with spare truck capacity through WhatsApp. The Next.js server receives webhook events and serves one read-only analytics page. A separate Node.js worker handles messages and shipment changes using MongoDB.

## Pilot workflow

New users who message Zunde for the first time get a short explanation of the service with the main menu. Anyone can reply **HELP** for an overview and short guides for shippers, truckers and receivers. The text lives in `src/guide.ts`.

1. The shipper opens **Find a truck** and submits pickup, destination, ready date, cargo type and weight. No registration is needed to see results. Searches can be reopened from **My activity**.
2. The trucker uses **Advertise space** to submit a route, departure, available tonnes and cargo types. On the first advert, Zunde asks for name, national ID, truck registration and company name. Completing that form unlocks posting and receiving requests. Staff do not review documents in the pilot.
3. The matcher returns up to ten future departures that cover the route in the right direction, leave on the ready date or next two calendar days in Zimbabwe, accept the cargo, and list enough space. It sorts by departure. The initial corridor runs Harare → Kwekwe → Gweru → Bulawayo → Hwange → Victoria Falls and supports both directions.
4. The shipper selects one truck for the load. At the first selection, Zunde asks for the shipper's name and uses their WhatsApp number. The trucker can submit a total price in USD or decline. The shipper can switch trucks while waiting. An unanswered request expires after two hours or at departure, whichever is earlier. A quoted offer remains available until departure, withdrawal or acceptance.
5. Accepting an offer confirms the shipment and shares both phone numbers. The parties arrange payment directly. A truck can take multiple shipments. The trucker manages capacity through **Update space** and should update it after accepting a shipment or when plans change.
6. The trucker marks the shipment delivered and the shipper confirms receipt or forwards the receipt link to their receiver. A separate receiver confirms by messaging Zunde with the link. Both confirmations are required and either can arrive first. The trucker cannot use the receiver link from the number attached to the shipment. A confirmed shipment can be cancelled before either delivery confirmation. Zunde records who cancelled and when and shows cancelled shipments under **My activity**.

The dashboard shows searches, adverts, searches that found at least one match, accepted offers, completed deliveries and cancellations, plus route and daily activity. Completed deliveries and cancellations are counted by event date. Search counts omit personal details and remain available when an unbooked search expires.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open [the local dashboard](http://localhost:3000). Development without a database displays labelled sample analytics. Copy `.env.example` to `.env.local` to connect a MongoDB replica set or Atlas cluster and serve actual pilot analytics. The dashboard requires the configured admin username and a password of at least 16 characters when connected to a database or running a production build.

## Connect WhatsApp

1. Generate the Flow definitions with `npm run flows`. Import each JSON file in `dist/whatsapp-flows/` into the pilot's WhatsApp Business Account, validate the forms in WhatsApp Manager, and publish them. Record each Flow ID in its matching `WA_FLOW_*` setting. The forms use the same town and cargo lists as the matcher.
2. Set the Meta app secret, phone number ID, access token, verify token and the Graph API version enabled for the app. Set `WA_BUSINESS_NUMBER` to the WhatsApp business number in international digits, with no plus sign, so recipients receive a tappable receipt link.
3. Serve the Next.js app over HTTPS and subscribe the Meta app to `messages` on `https://<your-host>/api/whatsapp/webhook`. Run `npm run worker` alongside it. The worker creates MongoDB indexes at startup. For self-hosting, run `npm run build` and `npm start`, and supervise the worker and web process with the server's process manager.
4. For notifications to people outside WhatsApp's customer-service window, configure an approved utility template with no variables, such as “You have a Zunde shipment update. Reply MENU and choose My activity.” Send it only to opted-in pilot participants. Without a configured template users can still retrieve updates from **My activity** when they message Zunde again.
5. Test with separate pilot WhatsApp numbers for a shipper, trucker and receiver. Use synthetic identity details until the test accounts and Flow configurations are verified.

The webhook verifies Meta's signature before saving events. MongoDB transactions commit business changes, message processing and outgoing messages together. The inbox deduplicates repeat events, and the worker retries temporary send failures. Keep the database key and credentials in the server environment. Back up the key securely alongside the database because it protects trucker IDs and signs receipt links.

## Deploy to an Oracle VM

`.github/workflows/deploy.yml` runs on pushes to `main` and `staging` (or manually). It typechecks, tests and builds, pushes a `linux/arm64` image to Docker Hub tagged with the commit SHA and branch, then deploys it over SSH with `docker compose`. One image runs both the web server and the worker.

One-time VM setup:

1. Install Docker with the Compose plugin and let the SSH user run `docker`.
2. Create `~/repos/zunde/.env` from `.env.example` with the production values. The workflow copies `docker-compose.yml` beside it and keeps `IMAGE` and `IMAGE_TAG` in that file up to date.
3. The web server listens on `127.0.0.1:3000`. Set `PORT` in `.env` to use another port. Put an HTTPS reverse proxy such as nginx or Caddy in front of it for the Meta webhook.

Repository secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_PASSWORD` (an access token), `ORACLE_VM_URL`, `SSH_USER` and `SSH_PRIVATE_KEY`.

A deploy succeeds when the webhook answers and the worker stays up without restarting for 15 seconds. Otherwise the workflow prints recent logs and restarts the previous image.

## Checks

```sh
npm run check
npm test
npm run build
```

Set `TEST_MONGODB_URI` to a disposable replica set and run `npm test` to include the integration test. It uses an isolated test database, sends signed synthetic WhatsApp webhooks and captures outgoing messages locally.

See the [Next.js Route Handlers guide](https://nextjs.org/docs/app/getting-started/route-handlers), [Meta's published Flow API example](https://www.postman.com/meta/whatsapp-business-platform/request/56fec8h/send-published-flow-by-name) and [MongoDB driver transaction guide](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/).
