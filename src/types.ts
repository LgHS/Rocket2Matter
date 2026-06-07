// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Types for the RocketChat side (MongoDB source) and the Mattermost side
 * (bulk import JSONL). Intentionally partial: only the fields used are described.
 */

// ----------------------------- RocketChat -----------------------------

export interface RcUser {
  _id: string;
  username?: string;
  name?: string;
  emails?: { address: string; verified?: boolean }[];
  roles?: string[];
  type?: string; // "bot" | "user" | ...
  active?: boolean;
  _mm?: string; // normalized Mattermost username (added during export)
}

export interface RcRoom {
  _id: string;
  t: "c" | "p" | "d" | "l" | string; // channel, private, direct, livechat
  name?: string;
  fname?: string; // display name
  topic?: string;
  description?: string;
  usernames?: string[]; // for DMs
  uids?: string[]; // for DMs
  u?: { _id: string; username: string };
}

export interface RcSubscription {
  _id: string;
  rid: string; // room id
  t: string; // room type
  name?: string;
  u: { _id: string; username: string };
  roles?: string[]; // "owner" | "moderator" | ...
  ls?: Date | string | number; // last seen (last read message)
}

export interface RcReactions {
  // key = ":emoji:" → { usernames: [...] }
  [emoji: string]: { usernames?: string[]; names?: string[] };
}

export interface RcFileRef {
  _id: string;
  name?: string;
  type?: string; // mime
}

/** RocketChat attachment (file caption, image preview, message quote…). */
export interface RcAttachment {
  description?: string; // a file's caption
  text?: string;
  title?: string;
  title_link?: string; // present for files
  image_url?: string; // present for images
  type?: string; // "file" for attachments
  author_name?: string; // present for message quotes
  message_link?: string; // present for message quotes
}

export interface RcMessage {
  _id: string;
  rid: string;
  msg?: string;
  ts: Date | string | number;
  u: { _id: string; username?: string; name?: string };
  t?: string; // present ⇒ system message (to be ignored)
  tmid?: string; // thread main id (⇒ this is a reply)
  reactions?: RcReactions;
  file?: RcFileRef;
  files?: RcFileRef[];
  attachments?: RcAttachment[];
}

export interface RcUpload {
  _id: string;
  name?: string;
  type?: string; // mime
  size?: number;
  rid?: string;
  userId?: string;
  store?: string; // "GridFS:Uploads" | "FileSystem:Uploads" | ...
}

// ----------------------------- Mattermost -----------------------------

export interface MmReaction {
  user: string;
  emoji_name: string;
  create_at: number;
}

export interface MmAttachment {
  path: string; // relative to the import zip root
}

export interface MmReply {
  user: string;
  message: string;
  create_at: number;
  reactions?: MmReaction[];
  attachments?: MmAttachment[];
}

export interface MmPost {
  team: string;
  channel: string;
  user: string;
  message: string;
  create_at: number;
  reactions?: MmReaction[];
  replies?: MmReply[];
  attachments?: MmAttachment[];
}

export interface MmDirectPost {
  channel_members: string[];
  user: string;
  message: string;
  create_at: number;
  reactions?: MmReaction[];
  replies?: MmReply[];
  attachments?: MmAttachment[];
}

export interface MmChannelMembership {
  name: string;
  roles: string; // "channel_user" | "channel_admin channel_user"
  // Read state (optional):
  last_viewed_at?: number;
  msg_count?: number;
  msg_count_root?: number;
  mention_count?: number;
}

export interface MmTeamMembership {
  name: string;
  roles: string;
  channels?: MmChannelMembership[];
}

/** A single line of the Mattermost import JSONL file. */
export type MmLine =
  | { type: "version"; version: number }
  | { type: "team"; team: { name: string; display_name: string; type: string } }
  | {
      type: "channel";
      channel: {
        team: string;
        name: string;
        display_name: string;
        type: "O" | "P";
        purpose?: string;
        header?: string;
        deleted_at?: number; // if set ⇒ channel archived on import
      };
    }
  | {
      type: "user";
      user: {
        username: string;
        email: string;
        roles: string;
        first_name?: string;
        last_name?: string;
        teams: MmTeamMembership[];
      };
    }
  | { type: "post"; post: MmPost }
  | { type: "direct_channel"; direct_channel: { members: string[]; header?: string } }
  | { type: "direct_post"; direct_post: MmDirectPost };