# Running Knight Bot on Replit

## Start the manager

Run `npm start` to start the private admin site and restore all bot instances recorded in MongoDB. The manager listens on port 5000.

Configure these Replit Secrets before starting:

- `ADMIN_USERNAME` and `ADMIN_PASSWORD` — admin sign-in
- `MONGODB_URL` — MongoDB connection string for admin sessions, bot instance records, and encrypted WhatsApp authentication
- `SESSION_SECRET` — stable secret used to sign admin sessions and encrypt WhatsApp authentication records

Open the site and sign in with the admin credentials. Use **Create a clone** to launch another bot process. Each clone has its own workspace, local bot data, and MongoDB-backed WhatsApp account session; use the pairing form to connect a different WhatsApp account.

The bot processes run separately inside this same Replit project and share its installed dependencies and resource limits. The clone button does not provision a separate Replit deployment or container.

Keep `SESSION_SECRET` unchanged after linking WhatsApp accounts. Changing it makes the saved admin sessions and encrypted WhatsApp sessions unreadable.
