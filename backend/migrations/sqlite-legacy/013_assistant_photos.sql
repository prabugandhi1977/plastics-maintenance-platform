-- A question to the breakdown assistant can carry a photo (stored as a ticket photo); the message points at it.
ALTER TABLE ticket_assistant_messages ADD COLUMN attachment_id TEXT REFERENCES attachments(id);
