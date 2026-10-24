-- The text of each document (manuals, data sheets, calibration certificates), so the AI can read them. Text is
-- read after the upload; file_text records how that went for each document, passages holds the text in passages of
-- a few hundred words with their page, for full-text search ranked by BM25.
CREATE TABLE file_text (
  file_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending','indexed','failed','no_text')),
  reason TEXT NOT NULL DEFAULT '',
  pages INTEGER,
  passages INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER);
-- doc is the document's title and filename, so a title that matches counts too.
CREATE VIRTUAL TABLE passages USING fts5(text, doc, machine_id UNINDEXED, signal_key UNINDEXED, file_id UNINDEXED, page UNINDEXED, tokenize='porter unicode61 remove_diacritics 2');
-- A file removed in any way (deleted, a photo replaced, or with its signal or machine) takes its text with it.
CREATE TRIGGER files_text_delete AFTER DELETE ON files BEGIN
  DELETE FROM passages WHERE file_id=old.id;
  DELETE FROM file_text WHERE file_id=old.id;
END;
CREATE TRIGGER files_text_update AFTER UPDATE OF data, machine_id, signal_key ON files BEGIN
  DELETE FROM passages WHERE file_id=old.id;
  UPDATE file_text SET status='pending', reason='', passages=0 WHERE file_id=old.id;
END;
