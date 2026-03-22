import { getDb } from './instance.js';
import { Reaction } from './instance.js';

export function storeReaction(reaction: Reaction): void {
  const db = getDb();
  if (!reaction.emoji) {
    db.prepare(
      `DELETE FROM reactions WHERE message_id = ? AND message_chat_jid = ? AND reactor_jid = ?`,
    ).run(reaction.message_id, reaction.message_chat_jid, reaction.reactor_jid);
    return;
  }
  db.prepare(
    `INSERT OR REPLACE INTO reactions (message_id, message_chat_jid, reactor_jid, reactor_name, emoji, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    reaction.message_id,
    reaction.message_chat_jid,
    reaction.reactor_jid,
    reaction.reactor_name || null,
    reaction.emoji,
    reaction.timestamp,
  );
}

export function getReactionsForMessage(
  messageId: string,
  chatJid: string,
): Reaction[] {
  return getDb()
    .prepare(
      `SELECT * FROM reactions WHERE message_id = ? AND message_chat_jid = ? ORDER BY timestamp`,
    )
    .all(messageId, chatJid) as Reaction[];
}

export function getMessagesByReaction(
  reactorJid: string,
  emoji: string,
  chatJid?: string,
): Array<
  Reaction & { content: string; sender_name: string; message_timestamp: string }
> {
  const sql = chatJid
    ? `
      SELECT r.*, m.content, m.sender_name, m.timestamp as message_timestamp
      FROM reactions r
      JOIN messages m ON r.message_id = m.id AND r.message_chat_jid = m.chat_jid
      WHERE r.reactor_jid = ? AND r.emoji = ? AND r.message_chat_jid = ?
      ORDER BY r.timestamp DESC
    `
    : `
      SELECT r.*, m.content, m.sender_name, m.timestamp as message_timestamp
      FROM reactions r
      JOIN messages m ON r.message_id = m.id AND r.message_chat_jid = m.chat_jid
      WHERE r.reactor_jid = ? AND r.emoji = ?
      ORDER BY r.timestamp DESC
    `;

  type Result = Reaction & {
    content: string;
    sender_name: string;
    message_timestamp: string;
  };
  return chatJid
    ? (getDb().prepare(sql).all(reactorJid, emoji, chatJid) as Result[])
    : (getDb().prepare(sql).all(reactorJid, emoji) as Result[]);
}

export function getReactionsByUser(
  reactorJid: string,
  limit: number = 50,
): Reaction[] {
  return getDb()
    .prepare(
      `SELECT * FROM reactions WHERE reactor_jid = ? ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(reactorJid, limit) as Reaction[];
}

export function getReactionStats(chatJid?: string): Array<{
  emoji: string;
  count: number;
}> {
  const sql = chatJid
    ? `
      SELECT emoji, COUNT(*) as count
      FROM reactions
      WHERE message_chat_jid = ?
      GROUP BY emoji
      ORDER BY count DESC
    `
    : `
      SELECT emoji, COUNT(*) as count
      FROM reactions
      GROUP BY emoji
      ORDER BY count DESC
    `;

  type Result = { emoji: string; count: number };
  return chatJid
    ? (getDb().prepare(sql).all(chatJid) as Result[])
    : (getDb().prepare(sql).all() as Result[]);
}
