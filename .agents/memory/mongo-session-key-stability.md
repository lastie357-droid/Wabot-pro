---
name: Mongo session key stability
description: Rotation consequences for the key used to encrypt Mongo-backed WhatsApp auth state.
---

Keep `SESSION_SECRET` unchanged while Mongo-backed WhatsApp sessions must remain usable. Auth records encrypted with a previous key cannot be decrypted with a replacement key; those bot instances must be reset and paired again.

**Why:** AES-GCM authentication fails when the key changes, so Mongo records cannot safely be restored by the application without the original key.

**How to apply:** Before rotating `SESSION_SECRET`, expect existing linked bot sessions to require a reset and fresh pairing. Never expose or log the secret itself.
